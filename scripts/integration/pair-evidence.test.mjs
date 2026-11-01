// WEB-09c R23-PAIR (I7), revision 24 (R23-PAIR.b), revision 25 (DA-PAIR-E, schema 3): a paired interval record is evidence only when it
// binds one interval's complete collection, exchanges, upstream AND altered bodies (re-read and re-parsed), downstream outcomes, barriers,
// terminal references, oracle and memory, and (schema 3) closes over what it advertises: its target, how it was driven, every attempt and
// held answer, exactly the persistence and activation witnesses the attempts require, and the case's required observations. The positive
// controls are built from GENUINE sync bodies (the shapes the backend answers: whole pages, pieces, a piece that is the revision's last
// while the feed continues, an empty live-edge page, a snapshot, Atlas error bodies) and must be accepted; each corruption must be refused
// by its own named check. Records the COMMON DRIVER itself produced are validated in pair-driver.test.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  identityProblems,
  SCHEMA,
  validateInterval,
} from "./pair-evidence.mjs";
import { hiddenProblems, shownProblems } from "./pair-recovery.mjs";
import { describeSync, INJECTED_410 } from "./pair-tap.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");

/** One fixture world: its body files, and builders that record exchanges as the tap and the end-of-interval join do. */
function world() {
  const bodies = {};
  let n = 0;
  const file = (bytes, kind) => {
    n += 1;
    const name = `${String(n).padStart(6, "0")}.${kind}.json`;
    bodies[name] = bytes;
    return name;
  };
  const describe = (bytes, kind) => ({
    bytes: bytes.length,
    sha256: sha(bytes),
    body_file: file(bytes, kind),
    ...describeSync(bytes),
  });
  const readBody = (f) => {
    if (!(f in bodies)) throw new Error(`ENOENT: no such file ${f}`);
    return bodies[f];
  };
  return { bodies, describe, readBody };
}
const changes = (k, prefix) =>
  Array.from({ length: k }, (_, i) => ({
    kind: "upsert",
    resource: { id: `${prefix}-${i}`, kind: "field" },
  }));
/** A piece of revision `revision`. */
const piece = (revision, index, last, hasMore, next) =>
  Buffer.from(
    JSON.stringify({
      phase: "delta",
      batches: [
        {
          revision,
          changes: changes(4, `r${revision}p${index}`),
          segment: { index, last },
        },
      ],
      next_cursor: next,
      has_more: hasMore,
    }),
  );
const whole = (revisions, hasMore, next, phase = "delta") =>
  Buffer.from(
    JSON.stringify({
      phase,
      batches: revisions.map((revision) => ({
        revision,
        changes: changes(3, `w${revision}`),
      })),
      next_cursor: next,
      has_more: hasMore,
    }),
  );
const error401 = Buffer.from(
  JSON.stringify({
    code: "invalid_session",
    message: "the session is no longer valid",
    details: [],
  }),
);
const error410 = Buffer.from(
  JSON.stringify({
    code: "resync_required",
    message: "the cursor cannot be continued",
    details: [],
  }),
);

/** What receiving `bytes` does to the client's chain (the driver's effect): a final piece or a page with batches activates, a piece stages. */
function effectOfBytes(bytes, status) {
  if (status !== 200) return "none";
  const d = describeSync(bytes);
  if (d.segment) return d.segment.last ? "activated" : "staged";
  return d.batches > 0 ? "activated" : "committed";
}
/** A sync exchange as the interval record carries it. `held: false`: an answer the hold never held (a recovery after a hand-off). */
function exchange(
  w,
  seq,
  cursor,
  bytes,
  {
    status = 200,
    client = "received",
    step = null,
    outcome,
    held = true,
    effect,
  } = {},
) {
  return {
    seq,
    label: "PAIR-W2:chromium:iv",
    proxy_id: 100 + seq,
    method: "GET",
    path: "/api/experimental/v1/sync",
    query: { cursor, limit: null, max_changes: "4" },
    status,
    ...w.describe(bytes, "upstream"),
    downstream: {
      outcome: outcome ?? (client === "lost" ? "client_gone" : "delivered"),
      events: held
        ? ["upstream_response", "held", "delivered"]
        : ["upstream_response", "delivered"],
    },
    ...(step === null
      ? {}
      : {
          attempt: {
            step,
            client,
            effect:
              effect ??
              (client === "lost" ? "none" : effectOfBytes(bytes, status)),
          },
        }),
  };
}
const other = (seq) => ({
  seq,
  label: "PAIR-W2:chromium:iv",
  proxy_id: 100 + seq,
  method: "POST",
  path: "/api/experimental/v1/access-commands",
  status: 200,
  downstream: { outcome: "delivered", events: ["delivered"] },
});
const memory = {
  kind: "chromium_cdp_js_heap_used",
  scope: "whole page",
  samples: [10, 12],
};
/** The server's answer to the workload, as the driver names it (pair-driver.mjs roleOf). */
const roleOf = (r, revisions) =>
  r.status !== 200
    ? "other"
    : !(r.batches > 0)
      ? "incidental"
      : revisions.includes(r.revision) && revisions.includes(r.last_revision)
        ? "target"
        : "unrelated";
/**
 * Schema 3's closure, as the producer writes it: the target (default: the terminal's revision), the drive mode, the opening, the hold's
 * releases, the observations, the top-level attempts (the same as each exchange's join, with its role), the bound pre-grant and grant
 * barriers, and one durable target_activated per activating attempt (placed before final_released). Negatives mutate the result.
 */
function finish(record, extra) {
  const revisions = extra.target ?? [record.terminal.applied_revision];
  record.target = {
    revisions,
    through: revisions.at(-1),
    sources: revisions.map((revision) => ({
      revision,
      source: "the public grant receipt (POST /access-commands)",
    })),
  };
  record.driven = extra.driven ?? "full";
  record.hand_off = extra.hand_off ?? null;
  record.opening = {
    label_seq: record.collection.since,
    rounds: 1,
    released: [],
  };
  record.hold_releases = extra.hold_releases ?? [];
  record.required_observations = extra.required_observations ?? [];
  record.observations = extra.observations ?? [];
  record.attempts = record.requests
    .filter((r) => r.attempt)
    .map((r) => ({
      step: r.attempt.step,
      seq: r.seq,
      proxy_id: r.proxy_id,
      request_cursor: r.query?.cursor ?? null,
      segment: r.segment ?? null,
      revision: r.revision ?? null,
      sha256: r.sha256,
      role: roleOf(r, revisions),
      phase: null,
      client: r.attempt.client,
      downstream: r.downstream.outcome,
      effect: r.attempt.effect,
    }));
  const barriers = record.barriers;
  barriers[0].detail = { cache_digest: "old-cache" };
  barriers[1].detail = { revision: revisions[0] };
  if (record.driven !== "none") {
    const witnesses = record.attempts
      .filter((a) => a.client === "received" && a.effect === "activated")
      .map((a) => {
        const r = record.requests.find((x) => x.seq === a.seq);
        const s = r.delivered ?? r;
        return {
          name: "target_activated",
          detail: {
            revision: s.segment ? s.revision : s.last_revision,
            activated_by_seq: a.seq,
            page_seq: 1,
            cache_digest: `cache-${a.seq}`,
            cache_count: 3,
          },
        };
      });
    const at = barriers.findIndex(
      (b) => b.name === "final_released" || b.name === "activation_complete",
    );
    barriers.splice(at < 0 ? barriers.length : at, 0, ...witnesses);
  }
  barriers.forEach((b, i) => {
    b.at = 1 + i;
  });
  return record;
}
function base(_w, requests, others, extra) {
  const seqs = [...requests, ...others].map((r) => r.seq);
  const { target, driven, hand_off, hold_releases, ...rest } = extra;
  return finish(
    {
      schema: SCHEMA,
      interval: "PAIR-W2:chromium:iv",
      case: "PAIR-W2",
      engine: "chromium",
      backend: "development",
      selection_manifest_sha256: "f434df4a",
      workload: "W-real",
      synthetic: false,
      pre_grant_cursor: "c0",
      collection: {
        since: Math.min(...seqs) - 1,
        until: Math.max(...seqs),
        dropped_through: 0,
        pending_writes: 0,
        write_errors: [],
        unsettled: [],
      },
      requests,
      other_requests: others,
      unaltered: true,
      oracle: { verdict: "match", problems: [] },
      memory: structuredClone(memory),
      ...rest,
    },
    { target, driven, hand_off, hold_releases },
  );
}
const barriers = (...rest) => [
  { name: "pre_grant_complete", at: 1 },
  { name: "grant_complete", at: 2 },
  ...rest.map((b, i) => ({ ...b, at: 3 + i })),
];
const persisted = (applied, observed) => ({
  name: "piece_persisted",
  detail: { applied_seq: applied, observed_at_seq: observed, next_index: 0 },
});
const released = (seq) => ({
  name: "final_released",
  detail: { seq, proxy_id: 100 + seq, outcome: "delivered" },
});
const activation = (revision, by) => ({
  name: "activation_complete",
  detail: { applied_revision: revision, activated_by_seq: by },
});

/** W2: three pieces of revision 7, driven; the last ends the feed. */
function segmented() {
  const w = world();
  const requests = [
    exchange(w, 12, "c0", piece(7, 0, false, true, "c1"), { step: 0 }),
    exchange(w, 13, "c1", piece(7, 1, false, true, "c2"), { step: 1 }),
    exchange(w, 14, "c2", piece(7, 2, true, false, "c3"), { step: 2 }),
  ];
  const record = base(w, requests, [other(11)], {
    barriers: barriers(
      persisted(12, 13),
      persisted(13, 14),
      released(14),
      activation(7, 14),
    ),
    pieces_persisted: 2,
    terminal: {
      kind: "activated",
      applied_revision: 7,
      final_seq: 14,
      activated_by_seq: 14,
    },
  });
  return { w, record };
}
const accept = ({ w, record }) =>
  assert.deepEqual(validateInterval(record, { readBody: w.readBody }), []);
const refuse = ({ w, record }, expected, name) => {
  const found = validateInterval(record, { readBody: w.readBody });
  assert.ok(
    found.some((p) => expected.test(p)),
    `${name}: ${JSON.stringify(found)}`,
  );
};

// ---- positive controls -------------------------------------------------------------------------------------------------------------
test("accepted: a driven segmented revision, every body re-read and re-parsed", () => {
  accept(segmented());
});

test("accepted: ONE whole response (W1), fully driven", () => {
  const w = world();
  const record = base(
    w,
    [exchange(w, 12, "c0", whole([7], false, "c1"), { step: 0 })],
    [other(11)],
    {
      barriers: barriers(released(12), activation(7, 12)),
      pieces_persisted: 0,
      terminal: {
        kind: "activated",
        applied_revision: 7,
        final_seq: 12,
        activated_by_seq: 12,
      },
    },
  );
  accept({ w, record });
});

test("accepted: the revision's last piece while the feed continues (segment.last with has_more true), then a later whole page completes it", () => {
  const w = world();
  const requests = [
    exchange(w, 12, "c0", piece(7, 0, false, true, "c1"), { step: 0 }),
    exchange(w, 13, "c1", piece(7, 1, true, true, "c2"), { step: 1 }),
    exchange(w, 14, "c2", whole([8], false, "c3"), { step: 2 }),
  ];
  const record = base(w, requests, [other(11)], {
    target: [7, 8],
    barriers: barriers(persisted(12, 13), released(14), activation(8, 14)),
    pieces_persisted: 1,
    terminal: {
      kind: "activated",
      applied_revision: 8,
      final_seq: 14,
      activated_by_seq: 14,
    },
  });
  accept({ w, record });
});

test("accepted: the revision activated by its last piece, the feed completed by an EMPTY live-edge page (two distinct references)", () => {
  const w = world();
  const requests = [
    exchange(w, 12, "c0", piece(7, 0, false, true, "c1"), { step: 0 }),
    exchange(w, 13, "c1", piece(7, 1, true, true, "c2"), { step: 1 }),
    exchange(w, 14, "c2", whole([], false, "c2"), { step: 2 }),
  ];
  const record = base(w, requests, [], {
    barriers: barriers(persisted(12, 13), released(14), activation(7, 13)),
    pieces_persisted: 1,
    terminal: {
      kind: "activated",
      applied_revision: 7,
      final_seq: 14,
      activated_by_seq: 13,
    },
  });
  accept({ w, record });
});

/** R1: piece 3 held, the page reloaded (the answer LOST downstream), asked again from the same cursor, received. */
function lostAndRetried() {
  const w = world();
  const p3 = piece(7, 3, false, true, "c4");
  const requests = [
    exchange(w, 12, "c0", piece(7, 0, false, true, "c1"), { step: 0 }),
    exchange(w, 13, "c1", piece(7, 1, false, true, "c2"), { step: 1 }),
    exchange(w, 14, "c2", piece(7, 2, false, true, "c3"), { step: 2 }),
    exchange(w, 15, "c3", p3, { step: 3, client: "lost" }),
    exchange(w, 16, "c3", p3, { step: 4 }),
    exchange(w, 17, "c4", piece(7, 4, true, false, "c5"), { step: 5 }),
  ];
  requests[3].attempt.effect = "none";
  const record = base(w, requests, [other(11)], {
    barriers: barriers(
      persisted(12, 13),
      persisted(13, 14),
      persisted(14, 15),
      persisted(16, 17),
      released(17),
      activation(7, 17),
    ),
    pieces_persisted: 4,
    terminal: {
      kind: "activated",
      applied_revision: 7,
      final_seq: 17,
      activated_by_seq: 17,
    },
  });
  return { w, record };
}
test("accepted: a lost attempt kept with its downstream outcome, then the same piece received from the same cursor (R1)", () => {
  accept(lostAndRetried());
});

test("accepted: an answer the TAP dropped (the server answered; nothing reached the client), asked again (R2)", () => {
  const w = world();
  const p2 = piece(7, 2, false, true, "c3");
  const dropped = exchange(w, 14, "c2", p2, { outcome: "upstream_error" });
  dropped.dropped = "TAP-INJECTED drop_connection";
  dropped.attempt = { step: null, client: "dropped", effect: "none" };
  const requests = [
    exchange(w, 12, "c0", piece(7, 0, false, true, "c1"), { step: 0 }),
    exchange(w, 13, "c1", piece(7, 1, false, true, "c2"), { step: 1 }),
    dropped,
    exchange(w, 15, "c2", p2, { step: 2 }),
    exchange(w, 16, "c3", piece(7, 3, true, false, "c4"), { step: 3 }),
  ];
  const record = base(w, requests, [other(11)], {
    unaltered: false,
    barriers: barriers(
      persisted(12, 13),
      persisted(13, 15),
      persisted(15, 16),
      released(16),
      activation(7, 16),
    ),
    pieces_persisted: 3,
    terminal: {
      kind: "activated",
      applied_revision: 7,
      final_seq: 16,
      activated_by_seq: 16,
    },
  });
  accept({ w, record });
});

/** G1: piece 1 altered by the tap (its index moved on: a gap) and delivered; the client restarts at the boundary. */
function injectedPiece() {
  const w = world();
  const p1 = piece(7, 1, false, true, "c2");
  const altered = JSON.parse(p1.toString("utf8"));
  altered.batches[0].segment.index += 1;
  const alteredBytes = Buffer.from(JSON.stringify(altered));
  const faulted = exchange(w, 13, "c1", p1, { step: 1 });
  faulted.delivered = {
    injected: "TAP-INJECTED segment_index_delta",
    status: 200,
    ...w.describe(alteredBytes, "delivered"),
  };
  faulted.attempt.effect = "restarted";
  const requests = [
    exchange(w, 12, "c0", piece(7, 0, false, true, "c1"), { step: 0 }),
    faulted,
    exchange(w, 14, "c0", piece(7, 0, false, true, "d1"), { step: 2 }),
    exchange(w, 15, "d1", piece(7, 1, false, true, "d2"), { step: 3 }),
    exchange(w, 16, "d2", piece(7, 2, true, false, "d3"), { step: 4 }),
  ];
  const record = base(w, requests, [other(11)], {
    unaltered: false,
    barriers: barriers(
      persisted(12, 13),
      persisted(14, 15),
      persisted(15, 16),
      released(16),
      activation(7, 16),
    ),
    pieces_persisted: 3,
    terminal: {
      kind: "activated",
      applied_revision: 7,
      final_seq: 16,
      activated_by_seq: 16,
    },
  });
  return { w, record };
}
test("accepted: an altered (TAP-INJECTED) piece delivered, its own bytes retained, the chain restarted at the boundary (G1)", () => {
  accept(injectedPiece());
});

/** X1: piece 1 answered 410 by the tap (client-only): driven up to that hand-off, then the recovery's cursor-less snapshot, unheld. */
function injected410() {
  const w = world();
  const p1 = piece(7, 1, false, true, "c2");
  const faulted = exchange(w, 13, "c1", p1, { step: 1, effect: "none" });
  const bytes = Buffer.from(JSON.stringify(INJECTED_410));
  faulted.delivered = {
    injected: "TAP-INJECTED answer_410",
    status: 410,
    ...w.describe(bytes, "delivered"),
  };
  const requests = [
    exchange(w, 12, "c0", piece(7, 0, false, true, "c1"), { step: 0 }),
    faulted,
    exchange(w, 14, null, whole([7], true, "s1", "snapshot"), {
      held: false,
    }),
    exchange(w, 15, "s1", whole([7], false, "s2", "snapshot"), {
      held: false,
    }),
  ];
  const record = base(w, requests, [other(11)], {
    unaltered: false,
    driven: "prefix",
    hand_off: { at_seq: 13, reason: "the injected 410" },
    barriers: barriers(persisted(12, 13), {
      name: "activation_complete",
      detail: { recovered: true, applied_revision: 7 },
    }),
    pieces_persisted: 1,
    terminal: {
      kind: "recovered",
      applied_revision: 7,
      final_seq: 15,
      activated_by_seq: 15,
    },
  });
  return { w, record };
}
test("accepted: an injected 410 with its retained bytes, the recovery's snapshot to its completion (X1)", () => {
  accept(injected410());
});

test("accepted: a REAL 410 for a tampered continuation (the altered piece retained), then the recovery (B1)", () => {
  const w = world();
  const p0 = piece(7, 0, false, true, "c1");
  const tampered = JSON.parse(p0.toString("utf8"));
  tampered.next_cursor = "c1X";
  const t0 = exchange(w, 12, "c0", p0, { step: 0 });
  t0.delivered = {
    injected: "TAP-INJECTED tamper_next_cursor",
    status: 200,
    ...w.describe(Buffer.from(JSON.stringify(tampered)), "delivered"),
  };
  const requests = [
    t0,
    exchange(w, 13, "c1X", error410, { status: 410, step: 1 }),
    exchange(w, 14, null, whole([7], false, "s1", "snapshot"), {
      held: false,
    }),
  ];
  const record = base(w, requests, [other(11)], {
    unaltered: false,
    driven: "prefix",
    hand_off: { at_seq: 13, reason: "the server's 410" },
    barriers: barriers(persisted(12, 13), {
      name: "activation_complete",
      detail: { recovered: true, applied_revision: 7 },
    }),
    pieces_persisted: 1,
    terminal: {
      kind: "recovered",
      applied_revision: 7,
      final_seq: 14,
      activated_by_seq: 14,
    },
  });
  accept({ w, record });
});

test("accepted: a non-barriered catch-up in pieces (RC1: the fenced recovery's reads, not driven)", () => {
  const w = world();
  const requests = [
    exchange(w, 12, "c0", piece(7, 0, false, true, "c1"), { held: false }),
    exchange(w, 13, "c1", piece(7, 1, true, false, "c2"), { held: false }),
  ];
  const record = base(w, requests, [other(11)], {
    driven: "none",
    barriers: barriers(activation(7, 13)),
    pieces_persisted: 0,
    terminal: {
      kind: "activated",
      applied_revision: 7,
      final_seq: 13,
      activated_by_seq: 13,
    },
  });
  accept({ w, record });
});

test("memory unavailable WITH a reason is accepted (never a bound)", () => {
  const s = segmented();
  s.record.memory = {
    kind: null,
    reason: "webkit: no supported per-page heap counter",
  };
  accept(s);
});

// ---- the review's two demonstrated omissions (R23-PAIR.b) ----------------------------------------------------------------------------
test("refused (review negative 1): the final response removed while final_released and the activation still refer to it", () => {
  const s = segmented();
  s.record.requests.pop();
  s.record.collection.until = 13;
  refuse(s, /feed's completion 14 is not an included answer/, "final removed");
  refuse(s, /activating answer 14 is not an included answer/, "final removed");
});

test("refused (review negative 2): an injected delivered answer whose body file does not exist (length 999, all-zero hash), upstream bytes valid", () => {
  const s = injected410();
  Object.assign(s.record.requests[1].delivered, {
    body_file: "nonexistent.delivered.json",
    bytes: 999,
    sha256: "0".repeat(64),
  });
  refuse(s, /requests\[1\] delivered: body file unreadable/, "altered body");
});

// ---- terminal closure ----------------------------------------------------------------------------------------------------------------
for (const [name, mutate, expected] of [
  [
    "the feed's completion named as a NON-final piece",
    (r) => (r.terminal.final_seq = 13),
    /completion 13 is not a 200 with has_more false/,
  ],
  [
    "the activation named as a non-final piece",
    (r) => (r.terminal.activated_by_seq = 13),
    /answer 13 does not activate revision 7/,
  ],
  [
    "another revision as the applied one",
    (r) => {
      r.terminal.applied_revision = 8;
      r.barriers.at(-1).detail.applied_revision = 8;
    },
    /does not activate revision 8/,
  ],
  [
    "the activation barrier naming another revision",
    (r) => (r.barriers.at(-1).detail.applied_revision = 6),
    /activation_complete names another revision/,
  ],
  [
    "no terminal references",
    (r) => {
      delete r.terminal.final_seq;
      delete r.terminal.activated_by_seq;
    },
    /completion undefined is not an included answer/,
  ],
  [
    "no applied revision",
    (r) => delete r.terminal.applied_revision,
    /names no applied revision/,
  ],
  [
    "final_released naming another answer",
    (r) =>
      (r.barriers.find((b) => b.name === "final_released").detail.seq = 13),
    /final_released does not name the feed's completion/,
  ],
  [
    "final_released whose release reached nobody",
    (r) =>
      (r.barriers.find((b) => b.name === "final_released").detail.outcome =
        "client_gone"),
    /final_released does not name the feed's completion, delivered/,
  ],
  [
    "two final_released barriers",
    (r) =>
      r.barriers.splice(-1, 0, {
        ...r.barriers.find((b) => b.name === "final_released"),
      }),
    /2 final_released barriers/,
  ],
  [
    "a final answer that never reached the client (the proxy found it gone)",
    (r) => (r.requests[2].downstream.outcome = "client_gone"),
    /completion 14 is not an included answer the client received/,
  ],
  [
    "no terminal state",
    (r) => (r.terminal.kind = "timeout"),
    /terminal "timeout"/,
  ],
])
  test(`refused: ${name}`, () => {
    const s = segmented();
    mutate(s.record);
    refuse(s, expected, name);
  });

test("refused: the activating answer is the LOST attempt (not the one the client received)", () => {
  const s = lostAndRetried();
  s.record.requests[3] = {
    ...s.record.requests[3],
  };
  s.record.terminal.activated_by_seq = 15;
  refuse(
    s,
    /activating answer 15 is not an included answer the client received/,
    "lost",
  );
});

test("refused: a recovered interval without any 410 before its activation", () => {
  const s = injected410();
  delete s.record.requests[1].delivered;
  s.record.unaltered = true;
  s.record.requests[2].query.cursor = "c2";
  refuse(s, /shows no 410 the client was answered/, "no 410");
});

test("refused: the activating answer after the feed's completion", () => {
  const w = world();
  const requests = [
    exchange(w, 12, "c0", whole([], false, "c0"), { held: false }),
    exchange(w, 13, "c0", whole([7], false, "c1"), { held: false }),
  ];
  const record = base(w, requests, [], {
    driven: "none",
    barriers: barriers(activation(7, 13)),
    pieces_persisted: 0,
    terminal: {
      kind: "activated",
      applied_revision: 7,
      final_seq: 12,
      activated_by_seq: 13,
    },
  });
  refuse({ w, record }, /comes after the feed's completion/, "order");
});

// ---- bodies: upstream and altered, bytes and metadata ------------------------------------------------------------------------------
for (const [name, mutate, expected] of [
  [
    "a corrupted upstream body hash",
    (r) => (r.requests[0].sha256 = "0".repeat(64)),
    /requests\[0\] upstream: body hash differs/,
  ],
  [
    "an upstream body of another length",
    (r) => (r.requests[0].bytes += 1),
    /requests\[0\] upstream: body is \d+ bytes, recorded/,
  ],
  [
    "a missing upstream body file",
    (r) => (r.requests[0].body_file = "missing.json"),
    /requests\[0\] upstream: body file unreadable/,
  ],
  [
    "a recorded next_cursor that is not the body's",
    (r) => (r.requests[0].next_cursor = "elsewhere"),
    /requests\[0\] upstream: recorded next_cursor is not the body's own/,
  ],
  [
    "a recorded segment that is not the body's",
    (r) => (r.requests[1].segment = { index: 1, last: true }),
    /requests\[1\] upstream: recorded segment is not the body's own/,
  ],
  [
    "a recorded has_more that is not the body's",
    (r) => (r.requests[2].has_more = true),
    /requests\[2\] upstream: recorded has_more is not the body's own/,
  ],
  [
    "a body's segment not recorded at all",
    (r) => delete r.requests[1].segment,
    /requests\[1\] upstream: the body's segment is not recorded/,
  ],
])
  test(`refused: ${name}`, () => {
    const s = segmented();
    mutate(s.record);
    refuse(s, expected, name);
  });

for (const [name, mutate, expected] of [
  [
    "an altered body's hash corrupted",
    (d) => (d.sha256 = "f".repeat(64)),
    /requests\[1\] delivered: body hash differs/,
  ],
  [
    "an altered body's length changed",
    (d) => (d.bytes += 3),
    /requests\[1\] delivered: body is \d+ bytes, recorded/,
  ],
  [
    "an altered body's file removed",
    (d) => (d.body_file = "gone.delivered.json"),
    /requests\[1\] delivered: body file unreadable/,
  ],
  [
    "an altered answer's recorded segment not its bytes'",
    (d) => (d.segment = { index: 1, last: false }),
    /requests\[1\] delivered: recorded segment is not the body's own/,
  ],
  [
    "an altered answer with no body descriptor",
    (d) => {
      delete d.sha256;
      delete d.bytes;
      delete d.body_file;
    },
    /requests\[1\] delivered: no body hash, length or file/,
  ],
  [
    "an altered answer not labelled",
    (d) => delete d.injected,
    /not labelled as injected/,
  ],
])
  test(`refused: ${name}`, () => {
    const s = injectedPiece();
    mutate(s.record.requests[1].delivered);
    refuse(s, expected, name);
  });

test("refused: no body reader (acceptance requires every body re-read)", () => {
  const s = segmented();
  const found = validateInterval(s.record);
  assert.ok(
    found.some((p) => /no body reader/.test(p)),
    JSON.stringify(found),
  );
});

// ---- attempts, downstream outcomes, the chain --------------------------------------------------------------------------------------
for (const [name, build, mutate, expected] of [
  [
    "a lost answer's cursor used by the next request (a lost answer gives no continuation)",
    lostAndRetried,
    (r) => {
      r.requests[4].query.cursor = "c4";
      r.requests[3].next_cursor = "c4";
    },
    /requests\[4\]: cursor not delivered earlier/,
  ],
  [
    "a piece counted as persisted twice (a repeated observation of one stage)",
    lostAndRetried,
    (r) => {
      r.barriers.splice(5, 0, persisted(14, 16));
      r.pieces_persisted = 5;
    },
    /piece 14 is counted as persisted twice/,
  ],
  [
    "a persistence credited to the LOST attempt",
    lostAndRetried,
    (r) => (r.barriers[5].detail.applied_seq = 15),
    /piece_persisted names 15: not an included answer the client received/,
  ],
  [
    "a persistence observed before the piece",
    segmented,
    (r) => (r.barriers[2].detail.observed_at_seq = 12),
    /was not observed at a later included request/,
  ],
  [
    "a persistence of the final piece",
    segmented,
    (r) => (r.barriers[3].detail.applied_seq = 14),
    /piece_persisted names 14: not a non-final piece/,
  ],
  [
    "a received attempt the proxy found gone",
    segmented,
    (r) => (r.requests[1].downstream.outcome = "client_gone"),
    /received by the client, but the proxy recorded client_gone/,
  ],
  [
    "an answer with no downstream outcome",
    segmented,
    (r) => delete r.requests[1].downstream,
    /requests\[1\]: no downstream outcome/,
  ],
  [
    "an answer with no proxy correlation id",
    segmented,
    (r) => delete r.requests[1].proxy_id,
    /requests\[1\]: no unique proxy correlation id/,
  ],
  [
    "two answers claiming one proxy entry",
    segmented,
    (r) => (r.requests[1].proxy_id = r.requests[0].proxy_id),
    /requests\[1\]: no unique proxy correlation id/,
  ],
  [
    "an exchange deleted from the chain",
    segmented,
    (r) => r.requests.splice(1, 1),
    /cursor not delivered earlier/,
  ],
  [
    "exchanges reordered",
    segmented,
    (r) => r.requests.reverse(),
    /sequence|cursor not delivered/,
  ],
  [
    "another interval's exchange",
    segmented,
    (r) => (r.requests[1].label = "other"),
    /not this interval/,
  ],
  [
    "an exchange that never completed",
    segmented,
    (r) => (r.requests[2].status = null),
    /did not complete/,
  ],
  ["no exchange at all", segmented, (r) => (r.requests = []), /no exchange/],
  [
    "an injected answer while claiming unaltered",
    injectedPiece,
    (r) => (r.unaltered = true),
    /claims to be unaltered/,
  ],
  [
    "a dropped answer recorded as delivered downstream",
    segmented,
    (r) => {
      r.unaltered = false;
      r.requests[0].dropped = "TAP-INJECTED drop_connection";
    },
    /a dropped answer is recorded as delivered downstream/,
  ],
  [
    "a dropped answer that is also delivered",
    injectedPiece,
    (r) => (r.requests[1].dropped = "TAP-INJECTED drop_connection"),
    /dropped answer is not labelled, or also delivered/,
  ],
])
  test(`refused: ${name}`, () => {
    const s = build();
    mutate(s.record);
    refuse(s, expected, name);
  });

// ---- collection: the window is complete, nothing lost, nothing pending --------------------------------------------------------------
for (const [name, mutate, expected] of [
  [
    "a body write failed",
    (c) =>
      c.write_errors.push({ file: "000002.upstream.json", error: "EISDIR" }),
    /body writes failed/,
  ],
  [
    "a body write still pending",
    (c) => (c.pending_writes = 1),
    /still pending/,
  ],
  ["an exchange still open", (c) => (c.unsettled = [14]), /still open/],
  [
    "the tap's bounded log lost records of the interval",
    (c) => (c.dropped_through = 12),
    /bounded log lost records/,
  ],
  [
    "an exchange of the window not recorded (a gap of a non-sync request)",
    (c) => (c.since = 9),
    /tap exchanges in the interval, \d+ recorded/,
  ],
  [
    "an exchange outside the window",
    (c) => (c.until = 13),
    /exchange 14 is outside the interval/,
  ],
  ["no collection window", (c) => delete c.until, /collection window/],
])
  test(`refused: ${name}`, () => {
    const s = segmented();
    mutate(s.record.collection);
    refuse(s, expected, name);
  });

test("refused: the other (non-sync) exchange removed from the record", () => {
  const s = segmented();
  s.record.other_requests = [];
  refuse(s, /4 tap exchanges in the interval, 3 recorded/, "gap");
});

// ---- barriers, identity, oracle, memory, schema --------------------------------------------------------------------------------------
for (const [name, mutate, expected] of [
  [
    "the activation before the final release",
    (r) => {
      const at = r.barriers.findIndex((b) => b.name === "final_released");
      r.barriers.splice(at, 2, r.barriers[at + 1], r.barriers[at]);
      r.barriers.forEach((b, i) => {
        b.at = 1 + i;
      });
    },
    /final_released out of order/,
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
    "a piece count that differs from the witnesses the attempts require",
    (r) => (r.pieces_persisted = 3),
    /3 pieces persisted recorded, 2 derived from the attempts/,
  ],
  [
    "a fully driven interval without its final release",
    (r) =>
      r.barriers.splice(
        r.barriers.findIndex((b) => b.name === "final_released"),
        1,
      ),
    /0 final_released barriers/,
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
    "a synthetic workload not labelled synthetic",
    (r) => (r.workload = "W-synthetic"),
    /not labelled synthetic/,
  ],
  [
    "a development interval naming no selection",
    (r) => delete r.selection_manifest_sha256,
    /selection manifest/,
  ],
  [
    "a schema-1 record (never upgraded)",
    (r) => (r.schema = "web09c-pair-interval/1"),
    /schema "web09c-pair-interval\/1"/,
  ],
  [
    "a schema-2 record (never upgraded or re-annotated)",
    (r) => (r.schema = "web09c-pair-interval/2"),
    /schema "web09c-pair-interval\/2"/,
  ],
])
  test(`refused: ${name}`, () => {
    const s = segmented();
    mutate(s.record);
    refuse(s, expected, name);
  });

// ---- schema 3 (revision 25, DA-PAIR-E): the record closes over what it advertises --------------------------------------------------
/** R24-PAIR.c's schedule, driven correctly: an empty poll answered during the grant (incidental), then the target's pieces, held each. */
function prefixed() {
  const w = world();
  const requests = [
    exchange(w, 12, "c0", whole([], false, "c0"), { step: 0 }),
    exchange(w, 13, "c0", piece(7, 0, false, true, "c1"), { step: 1 }),
    exchange(w, 14, "c1", piece(7, 1, false, true, "c2"), { step: 2 }),
    exchange(w, 15, "c2", piece(7, 2, true, false, "c3"), { step: 3 }),
  ];
  const record = base(w, requests, [other(11)], {
    barriers: barriers(
      persisted(13, 14),
      persisted(14, 15),
      released(15),
      activation(7, 15),
    ),
    pieces_persisted: 2,
    terminal: {
      kind: "activated",
      applied_revision: 7,
      final_seq: 15,
      activated_by_seq: 15,
    },
  });
  return { w, record };
}
/** T1: the last piece activates with the feed continuing; an empty page completes it; the follower read at both holds. */
function follower() {
  const w = world();
  const requests = [
    exchange(w, 12, "c0", piece(7, 0, false, true, "c1"), { step: 0 }),
    exchange(w, 13, "c1", piece(7, 1, true, true, "c2"), { step: 1 }),
    exchange(w, 14, "c2", whole([], false, "c2"), { step: 2 }),
  ];
  const record = base(w, requests, [], {
    barriers: barriers(persisted(12, 13), released(14), activation(7, 13)),
    pieces_persisted: 1,
    terminal: {
      kind: "activated",
      applied_revision: 7,
      final_seq: 14,
      activated_by_seq: 13,
    },
  });
  record.case = "PAIR-T1";
  record.required_observations = [
    "follower_old_at_last_piece",
    "follower_new_after_activation",
  ];
  record.observations = [
    {
      kind: "follower_old_at_last_piece",
      at_seq: 13,
      cache_digest: "old-cache",
    },
    {
      kind: "follower_new_after_activation",
      at_seq: 14,
      cache_digest: "cache-13",
    },
  ];
  return { w, record };
}
test("accepted: an EMPTY poll before the target (R24-PAIR.c's schedule) kept as an incidental attempt, then the target driven to its activation", () => {
  accept(prefixed());
});
test("accepted: T1's follower observations at the held last piece (old cache) and at the completion page after the activation (new cache)", () => {
  accept(follower());
});
test("accepted: an answer held after the feed's completion, released with the hold at the end of the interval (kept as a release)", () => {
  const s = segmented();
  const w = s.w;
  const late = exchange(w, 15, "c3", whole([], false, "c3"));
  s.record.requests.push(late);
  s.record.collection.until = 15;
  s.record.hold_releases = [
    {
      proxy_id: late.proxy_id,
      outcome: "delivered",
      reason: "the end of the interval",
    },
  ];
  accept(s);
});
test("accepted: L1, driven up to an explicit hand-off (piece 1 held, the session replaced), then the recovery's catch-up unheld to the activation", () => {
  const w = world();
  const requests = [
    exchange(w, 12, "c0", piece(7, 0, false, true, "c1"), { step: 0 }),
    exchange(w, 13, "c1", piece(7, 1, false, true, "c2"), { step: 1 }),
    exchange(w, 14, "c2", error401, { status: 401, held: false }),
    exchange(w, 15, "c2", piece(7, 2, true, false, "c3"), { held: false }),
  ];
  const record = base(w, requests, [other(11)], {
    driven: "prefix",
    hand_off: { at_seq: 13, reason: "the session was replaced" },
    barriers: barriers(persisted(12, 13), activation(7, 15)),
    pieces_persisted: 1,
    terminal: {
      kind: "activated",
      applied_revision: 7,
      final_seq: 15,
      activated_by_seq: 15,
    },
  });
  accept({ w, record });
});

for (const [name, build, mutate, expected] of [
  // DA-PAIR-E's demonstrated omissions: removing every witness or every attempt and held event was accepted by schema 2.
  [
    "every persistence witness removed and the count adjusted",
    prefixed,
    (r) => {
      r.barriers = r.barriers.filter((b) => b.name !== "piece_persisted");
      r.pieces_persisted = 0;
    },
    /staged piece 13 has no persistence witness at the next held request 14/,
  ],
  [
    "one persistence witness removed and the count adjusted",
    prefixed,
    (r) => {
      r.barriers.splice(
        r.barriers.findIndex((b) => b.name === "piece_persisted"),
        1,
      );
      r.pieces_persisted = 1;
    },
    /staged piece 13 has no persistence witness/,
  ],
  [
    "every attempt and held event removed",
    prefixed,
    (r) => {
      r.attempts = [];
      for (const x of r.requests) {
        delete x.attempt;
        x.downstream.events = x.downstream.events.filter((e) => e !== "held");
      }
    },
    /exchange 12 precedes the end of the drive but is no attempt/,
  ],
  [
    "one exchange's attempt removed from both lists",
    prefixed,
    (r) => {
      r.attempts = r.attempts.filter((a) => a.seq !== 14);
      delete r.requests[2].attempt;
    },
    /exchange 14 precedes the end of the drive but is no attempt/,
  ],
  [
    "a driven attempt whose answer the proxy never held",
    prefixed,
    (r) =>
      (r.requests[1].downstream.events = ["upstream_response", "delivered"]),
    /attempt 13 was driven, but the proxy never held its answer/,
  ],
  [
    "the top-level attempts disagreeing with an exchange's join",
    prefixed,
    (r) => (r.attempts[1].effect = "none"),
    /attempt 13: the exchange's join is not the attempt/,
  ],
  [
    "a top-level attempt missing (the exchange still carries it)",
    prefixed,
    (r) => (r.attempts = r.attempts.filter((a) => a.seq !== 13)),
    /exchange 13 carries an attempt the record does not list/,
  ],
  [
    "an attempt's role not the server's answer's",
    prefixed,
    (r) => (r.attempts[0].role = "target"),
    /attempt 12: role target, the server's answer is incidental/,
  ],
  [
    "a held answer neither an attempt nor a recorded release",
    segmented,
    (r) => {
      r.requests.push(exchange(world(), 15, "c3", whole([], false, "c3")));
      r.collection.until = 15;
    },
    /exchange 15 was held, but is neither an attempt nor a recorded release/,
  ],
  [
    "the EMPTY prefix poll named as the feed's completion (R24-PAIR.c's terminal)",
    prefixed,
    (r) => {
      r.terminal.final_seq = 12;
      r.barriers.find((b) => b.name === "final_released").detail.seq = 12;
    },
    /the activating answer comes after the feed's completion/,
  ],
  [
    "the EMPTY prefix poll named as the activating answer",
    prefixed,
    (r) => (r.terminal.activated_by_seq = 12),
    /answer 12 does not activate revision 7/,
  ],
  [
    "a terminal revision that is not the target's",
    segmented,
    (r) => {
      r.target = {
        revisions: [6],
        through: 6,
        sources: [{ revision: 6, source: "receipt" }],
      };
      r.barriers[1].detail.revision = 6;
    },
    /the terminal revision 7 is not the target's 6/,
  ],
  [
    "a received piece of an UNRELATED revision",
    segmented,
    (r) => {
      r.target = {
        revisions: [6],
        through: 6,
        sources: [{ revision: 6, source: "receipt" }],
      };
    },
    /exchange 12: revision 7..7 is not a target revision/,
  ],
  [
    "no target",
    segmented,
    (r) => delete r.target,
    /the target names no increasing positive revisions/,
  ],
  [
    "a target revision without its source",
    segmented,
    (r) => (r.target.sources = []),
    /a target revision names no source/,
  ],
  [
    "grant_complete not bound to the target",
    segmented,
    (r) => (r.barriers[1].detail.revision = 99),
    /grant_complete does not name the target's first revision/,
  ],
  [
    "the activation's durable witness removed",
    segmented,
    (r) =>
      (r.barriers = r.barriers.filter((b) => b.name !== "target_activated")),
    /0 target_activated barriers, 1 activating attempts/,
  ],
  [
    "the activation's durable witness naming another answer",
    segmented,
    (r) =>
      (r.barriers.find(
        (b) => b.name === "target_activated",
      ).detail.activated_by_seq = 13),
    /the activation by 14 has no durable witness/,
  ],
  [
    "a partly driven record without its hand-off",
    injected410,
    (r) => (r.hand_off = null),
    /a partly driven record names no hand-off/,
  ],
  [
    "a hand-off at an exchange that was not driven",
    injected410,
    (r) => (r.hand_off.at_seq = 14),
    /the hand-off 14 is not a driven attempt/,
  ],
  [
    "a fully driven record labelled undriven",
    segmented,
    (r) => (r.driven = "none"),
    /an undriven record lists attempts/,
  ],
  ["no drive mode", segmented, (r) => delete r.driven, /driven undefined/],
  [
    "the window not starting at the opening's label",
    segmented,
    (r) => (r.opening.label_seq = 3),
    /the window does not start at the opening's label/,
  ],
  [
    "no opening",
    segmented,
    (r) => delete r.opening,
    /the opening .* is not recorded/,
  ],
  [
    "no record of the hold's releases",
    segmented,
    (r) => delete r.hold_releases,
    /the hold's releases are not recorded/,
  ],
  [
    "no old cache digest at the pre-grant barrier",
    segmented,
    (r) => delete r.barriers[0].detail,
    /pre_grant_complete names no old cache digest/,
  ],
  [
    "T1's last-piece observation removed",
    follower,
    (r) => r.observations.shift(),
    /the required observation follower_old_at_last_piece is missing/,
  ],
  [
    "T1's last-piece observation made at an earlier piece",
    follower,
    (r) => (r.observations[0].at_seq = 12),
    /follower_old_at_last_piece is not made at the target's held last piece/,
  ],
  [
    "T1's last-piece observation showing the new cache",
    follower,
    (r) => (r.observations[0].cache_digest = "cache-13"),
    /follower_old_at_last_piece does not show the old live cache/,
  ],
  [
    "T1's after-activation observation made before the activation",
    follower,
    (r) => (r.observations[1].at_seq = 12),
    /follower_new_after_activation is not made after the target's activation/,
  ],
  [
    "T1's after-activation observation showing the old cache",
    follower,
    (r) => (r.observations[1].cache_digest = "old-cache"),
    /follower_new_after_activation does not show the activated cache/,
  ],
  [
    "an unknown required observation",
    follower,
    (r) => {
      r.required_observations.push("something");
      r.observations.push({ kind: "something", at_seq: 14, cache_digest: "x" });
    },
    /unknown required observation something/,
  ],
])
  test(`refused (schema 3): ${name}`, () => {
    const s = build();
    mutate(s.record);
    refuse(s, expected, name);
  });

test("the runner's identity check: the record is the case, engine, backend and selection it is filed under", () => {
  const { record } = segmented();
  const where = {
    file: "PAIR-W2.chromium.json",
    engine: "chromium",
    backend: "development",
    manifest: "f434df4a",
    row: { workload: "W-real", driven: "full", observations: [] },
  };
  assert.deepEqual(identityProblems(record, where), []);
  for (const [change, expected] of [
    [{ file: "PAIR-W3.chromium.json" }, /holds the record of PAIR-W2/],
    [{ engine: "firefox" }, /the stack ran firefox/],
    [{ backend: "released" }, /the stack ran released/],
    [{ manifest: null }, /not the approved one/],
    [{ row: undefined }, /not a case of the matrix/],
    [
      { row: { workload: "W-synthetic", driven: "full", observations: [] } },
      /the matrix says W-synthetic/,
    ],
    // Revision 25: the drive mode and the required observations are the matrix's, never the producer's choice.
    [
      { row: { workload: "W-real", driven: "none", observations: [] } },
      /driven full, the matrix says none/,
    ],
    [
      {
        row: {
          workload: "W-real",
          driven: "full",
          observations: ["follower_old_at_last_piece"],
        },
      },
      /required observations \[\], the matrix says/,
    ],
  ]) {
    const found = identityProblems(record, { ...where, ...change });
    assert.ok(
      found.some((p) => expected.test(p)),
      JSON.stringify(found),
    );
  }
  assert.ok(
    identityProblems({ ...record, interval: "PAIR-W3:chromium:x" }, where).some(
      (p) => /does not name its case and engine/.test(p),
    ),
  );
});

// ---- revision 26 (R26-DIAG): X0/X2's observation at the held REAL 410 ---------------------------------------------------------------
/** X0/X2 shape: piece 0 staged, the continuation answered by the server's own 410 (held, the hand-off), then the recovery's snapshot. */
function realRefusal(change = {}) {
  const w = world();
  const requests = [
    exchange(w, 12, "c0", piece(7, 0, false, true, "c1"), { step: 0 }),
    exchange(w, 13, "c1", error410, { status: 410, step: 1 }),
    exchange(w, 14, null, whole([7], false, "s1", "snapshot"), { held: false }),
  ];
  const record = base(w, requests, [other(11)], {
    driven: "prefix",
    hand_off: { at_seq: 13, reason: "the server's real 410" },
    barriers: barriers(persisted(12, 13), {
      name: "activation_complete",
      detail: { recovered: true, applied_revision: 7 },
    }),
    pieces_persisted: 1,
    terminal: {
      kind: "recovered",
      applied_revision: 7,
      final_seq: 14,
      activated_by_seq: 14,
    },
  });
  record.case = "PAIR-X0";
  record.required_observations = ["reader_old_at_refusal"];
  record.observations = [
    {
      kind: "reader_old_at_refusal",
      at_seq: 13,
      cache_digest: "old-cache",
      stage: { revision: 7, next_index: 1 },
      ...change,
    },
  ];
  return { w, record };
}
test("accepted (revision 26): the reader's old cache and persisted stage observed at the held real 410 it handed off at", () => {
  accept(realRefusal());
});
for (const [name, change, expected] of [
  [
    "observed at the staged piece, not the 410",
    { at_seq: 12 },
    /reader_old_at_refusal is not made at the held 410/,
  ],
  [
    "the activated or another cache",
    { cache_digest: "cache-12" },
    /does not show the old live cache/,
  ],
  ["no persisted stage", { stage: null }, /does not show a persisted stage/],
  [
    "a stage with nothing staged",
    { stage: { revision: 7, next_index: 0 } },
    /does not show a persisted stage/,
  ],
]) {
  test(`refused (revision 26): reader_old_at_refusal ${name}`, () => {
    refuse(realRefusal(change), expected, name);
  });
}
test("refused (revision 26): reader_old_at_refusal at a held 410 the interval did NOT hand off at", () => {
  const r = realRefusal();
  r.record.hand_off = { at_seq: 12, reason: "elsewhere" };
  refuse(
    r,
    /reader_old_at_refusal is not made at the held 410 the interval handed off at/,
    "not the hand-off",
  );
});
test("refused (revision 26): a required reader_old_at_refusal that was never made", () => {
  const r = realRefusal();
  r.record.observations = [];
  refuse(r, /required observation reader_old_at_refusal is missing/, "missing");
});
test("refused (revision 26): a diagnostic interval naming no selection", () => {
  const r = realRefusal();
  r.record.backend = "diagnostic";
  delete r.record.selection_manifest_sha256;
  refuse(
    r,
    /a diagnostic interval names no selection manifest hash/,
    "no selection",
  );
});

// ---- revision 27 (R27-DIAG.b): the recovery observed at held snapshot pages; the recovery caller's re-armed hold --------------------
/** Revision 28: the renderings `renderingOf` reports (the real view kinds; no `fenced` view exists). */
const ACCOUNT = "reader-acct";
const RENDER = {
  // The ordinary recovery: the displaying account behind the cache gate's visible refreshing placeholder.
  refreshing: (reader) => ({
    status: "observed",
    document: `${reader}-document`,
    attachment: reader,
    view: { kind: "displaying", account_id: ACCOUNT, state: null },
    root: { present: true, gated: false, mounted: true },
    placeholders: { present: 1, refreshing_visible: 1 },
  }),
  // The fenced recovery: the neutral state over the gated protected tree.
  neutral: (reader) => ({
    status: "observed",
    document: `${reader}-document`,
    attachment: reader,
    view: { kind: "neutral", account_id: null, state: "1e.checking" },
    root: { present: true, gated: true, mounted: true },
    placeholders: { present: 1, refreshing_visible: 1 },
  }),
  // The recovered account shown.
  shown: (reader) => ({
    status: "observed",
    document: `${reader}-document`,
    attachment: reader,
    view: { kind: "displaying", account_id: ACCOUNT, state: null },
    root: { present: true, gated: false, mounted: true },
    placeholders: { present: 0, refreshing_visible: 0 },
  }),
};
const withoutRender = ({ render: _render, ...rest }) => rest;
const readerState = (reader, extra = {}) => ({
  reader,
  page: `${reader}-page`,
  account: ACCOUNT,
  cache_status: "invalid",
  cursor: null,
  phase: "snapshot",
  delta_stage: null,
  staged: 0,
  staging_rows: 0,
  staging_generations: [],
  recovery_generation: 6,
  cache_digest: "old-cache",
  applied_revision: 6,
  notice: null,
  fenced: false,
  ...withoutRender(extra),
  rendering: RENDER[extra.render ?? "refreshing"](reader),
});
const pair = (extra = {}, follower = {}) => ({
  leader: readerState("leader", extra),
  follower: readerState("follower", { ...extra, ...follower }),
});
const SCHEMA_DETAIL = { schema: "web09c-recovery-observation/2" };
/** X0's real 410 at 13 (the hand-off), then three snapshot pages 14, 15, 16, each held and released by a recorded release. */
function observedRecovery({ caller = "ordinary", rearmed = false } = {}) {
  const w = world();
  const pre = rearmed
    ? [exchange(w, 12, "c0", error401, { status: 401, held: false })]
    : [];
  const first = rearmed ? 13 : 12;
  const requests = [
    ...pre,
    exchange(w, first, "c0", piece(7, 0, false, true, "c1"), { step: 0 }),
    exchange(w, first + 1, "c1", error410, { status: 410, step: 1 }),
    exchange(w, first + 2, null, whole([7], true, "s1", "snapshot")),
    exchange(w, first + 3, "s1", whole([7], true, "s2", "snapshot")),
    exchange(w, first + 4, "s2", whole([7], false, "s3", "snapshot")),
  ];
  const [p1, p2, p3] = [first + 2, first + 3, first + 4];
  const record = base(w, requests, [other(11)], {
    driven: rearmed ? "rearmed_prefix" : "prefix",
    hand_off: { at_seq: first + 1, reason: "the server's real 410" },
    hold_releases: [p1, p2, p3].map((seq) => ({
      proxy_id: 100 + seq,
      outcome: "delivered",
      reason: "recovery observation",
    })),
    barriers: barriers(persisted(first, first + 1), {
      name: "activation_complete",
      detail: { recovered: true, applied_revision: 7 },
    }),
    pieces_persisted: 1,
    terminal: {
      kind: "recovered",
      applied_revision: 7,
      final_seq: p3,
      activated_by_seq: p3,
    },
  });
  if (rearmed)
    record.rearm = {
      at_seq: 12,
      reason: "re-armed before the grant",
      released_rule: "r0",
    };
  record.case = rearmed ? "PAIR-XR0" : "PAIR-X0";
  record.caller = caller;
  record.local_work = false;
  const recovery = caller === "recovery";
  const fence = recovery
    ? { fenced: true, notice: { reason: "resync_required" }, render: "neutral" }
    : {};
  record.reader_account = ACCOUNT;
  record.required_observations = [
    "reader_old_at_refusal",
    "recovery_invalidated",
    "recovery_staged_hidden",
    "recovery_final_held",
    "recovery_activated",
    "recovery_rendered",
  ];
  const staged = { staging_rows: 4, staging_generations: [6], ...fence };
  record.observations = [
    {
      kind: "reader_old_at_refusal",
      at_seq: first + 1,
      cache_digest: "old-cache",
      stage: { revision: 7, next_index: 1 },
    },
    {
      kind: "recovery_invalidated",
      at_seq: p1,
      cache_digest: "old-cache",
      detail: { ...SCHEMA_DETAIL, ...pair(fence), generation_at_refusal: 5 },
    },
    {
      kind: "recovery_staged_hidden",
      at_seq: p2,
      cache_digest: "old-cache",
      detail: { ...SCHEMA_DETAIL, ...pair(staged) },
    },
    {
      kind: "recovery_final_held",
      at_seq: p3,
      cache_digest: "old-cache",
      detail: {
        ...SCHEMA_DETAIL,
        ...pair({ ...staged, staging_rows: 8 }),
        // Revision 28 (C4): both readers at every held page after the first.
        pages: [
          { seq: p2, ...pair(staged) },
          { seq: p3, ...pair({ ...staged, staging_rows: 8 }) },
        ],
      },
    },
    {
      kind: "recovery_activated",
      at_seq: p3,
      cache_digest: "new-cache",
      detail: {
        ...SCHEMA_DETAIL,
        // The data activation is legal while the recovery caller's fence still stands (its pages still hidden).
        ...pair({
          cache_status: "valid",
          cache_digest: "new-cache",
          applied_revision: 7,
          ...(recovery
            ? { fenced: true, render: "neutral" }
            : { render: "shown" }),
        }),
        rows_sha256: "a".repeat(64),
      },
    },
    {
      kind: "recovery_rendered",
      at_seq: p3,
      cache_digest: "new-cache",
      detail: {
        ...SCHEMA_DETAIL,
        ...pair({
          cache_status: "valid",
          cache_digest: "new-cache",
          applied_revision: 7,
          fenced: false,
          render: "shown",
        }),
      },
    },
  ];
  return { w, record, p1, p2, p3 };
}
const obs = (r, kind) => r.record.observations.find((o) => o.kind === kind);
test("accepted (revision 27): the ordinary caller's recovery observed invalidated, staged hidden, last page held and exposed once, by leader and follower", () => {
  accept(observedRecovery());
});
test("accepted (revision 27): the recovery caller's W24 restart (notice, snapshot phase, fenced) with the hold re-armed after the 401", () => {
  accept(observedRecovery({ caller: "recovery", rearmed: true }));
});
for (const [name, edit, expected] of [
  [
    "the invalidation observation missing",
    (r) => r.record.observations.splice(1, 1),
    /required observation recovery_invalidated is missing/,
  ],
  [
    "a valid cache at the invalidation",
    (r) =>
      (obs(r, "recovery_invalidated").detail.leader.cache_status = "valid"),
    /leader still shows a valid cache/,
  ],
  [
    "no new generation at the invalidation",
    (r) => (obs(r, "recovery_invalidated").detail.generation_at_refusal = 6),
    /has no new recovery generation/,
  ],
  [
    "the delta stage kept at the invalidation",
    (r) => (obs(r, "recovery_invalidated").detail.leader.staged = 3),
    /keeps the abandoned delta stage/,
  ],
  [
    "snapshot rows before the first page",
    (r) => (obs(r, "recovery_invalidated").detail.follower.staging_rows = 2),
    /holds snapshot rows before the first page/,
  ],
  [
    "the follower is the leading page",
    (r) =>
      (obs(r, "recovery_staged_hidden").detail.follower.page = "leader-page"),
    /follower is the leading page itself/,
  ],
  [
    "no follower",
    (r) => delete obs(r, "recovery_staged_hidden").detail.follower,
    /not made by the leader AND a follower/,
  ],
  [
    "the live cache changed while staged (a partial exposure)",
    (r) =>
      (obs(r, "recovery_staged_hidden").detail.leader.cache_digest = "partly"),
    /live cache changed before the activation/,
  ],
  [
    "staged rows of another generation",
    (r) =>
      (obs(r, "recovery_staged_hidden").detail.follower.staging_generations = [
        6, 7,
      ]),
    /not all of the recovery's generation/,
  ],
  [
    "shown while staged",
    (r) =>
      Object.assign(obs(r, "recovery_final_held").detail.leader, {
        cache_status: "valid",
      }),
    /shows a valid cache before the last page/,
  ],
  [
    "the last page held is not the last page",
    (r) => (obs(r, "recovery_final_held").at_seq = r.p2),
    /is not the last snapshot page/,
  ],
  [
    "the exposure not at the activating page",
    (r) => (obs(r, "recovery_activated").at_seq = r.p2),
    /not made at the terminal's activating snapshot page/,
  ],
  [
    "the follower reads another cache after the exposure",
    (r) =>
      (obs(r, "recovery_activated").detail.follower.cache_digest = "other"),
    /follower does not read the activated cache/,
  ],
  [
    "rows still staged after the exposure",
    (r) => (obs(r, "recovery_activated").detail.leader.staging_rows = 1),
    /still holds staged rows after the activation/,
  ],
  [
    "the old cache shown after the exposure",
    (r) =>
      (obs(r, "recovery_activated").detail.follower.cache_digest = "old-cache"),
    /still shows the old cache|still holds the old cache/,
  ],
  [
    "no row hash",
    (r) => delete obs(r, "recovery_activated").detail.rows_sha256,
    /activated rows are not hashed/,
  ],
  [
    "a page that was not released by a recorded release",
    (r) => r.record.hold_releases.splice(0, 1),
    /not held and released by a recorded release|neither an attempt nor a recorded release/,
  ],
  [
    "an ordinary caller that is fenced",
    (r) => (obs(r, "recovery_invalidated").detail.leader.fenced = true),
    /an ordinary caller is fenced/,
  ],
])
  test(`refused (revision 27): ${name}`, () => {
    const r = observedRecovery();
    edit(r);
    refuse(r, expected, name);
  });
for (const [name, edit, expected] of [
  [
    "W18's state filed as the recovery caller (no snapshot restart, no notice)",
    (r) =>
      Object.assign(obs(r, "recovery_invalidated").detail.leader, {
        phase: "delta",
        notice: null,
      }),
    /did not restart the snapshot|did not record its server restart/,
  ],
  [
    "the fence cleared while staged",
    (r) => (obs(r, "recovery_staged_hidden").detail.leader.fenced = false),
    /fence was cleared before the snapshot was complete/,
  ],
  [
    "an attempt before the re-arming",
    (r) => (r.record.rearm.at_seq = 13),
    /an attempt before the hold was re-armed|re-armed after/,
  ],
  [
    "the hold re-armed after the hand-off",
    (r) => (r.record.rearm.at_seq = 20),
    /re-armed after the hand-off/,
  ],
  ["no re-arming recorded", (r) => delete r.record.rearm, /names no re-arming/],
  [
    "the 401 before the re-arming made an attempt",
    (r) => (r.record.rearm.at_seq = 11),
    /precedes the end of the drive but is no attempt/,
  ],
])
  test(`refused (revision 27, recovery caller): ${name}`, () => {
    const r = observedRecovery({ caller: "recovery", rearmed: true });
    edit(r);
    refuse(r, expected, name);
  });
test("refused (revision 27): a re-arming on a record that is not re-armed", () => {
  const r = observedRecovery();
  r.record.rearm = { at_seq: 11, reason: "x", released_rule: "r0" };
  refuse(r, /only a re-armed record has a re-arming/, "rearm");
});
test("refused (revision 27): the target answered unheld before the re-armed hold", () => {
  const r = observedRecovery({ caller: "recovery", rearmed: true });
  const w = r.w;
  r.record.requests.splice(
    0,
    1,
    exchange(w, 12, "c0", piece(7, 0, false, true, "c1"), { held: false }),
  );
  refuse(r, /carried the target before the hold was re-armed/, "unheld target");
});
test("identity (revision 27): the caller and the local-work declaration are the matrix row's", () => {
  const r = observedRecovery();
  const row = {
    id: "PAIR-X0",
    workload: "W-real",
    driven: "prefix",
    caller: "ordinary",
    observations: r.record.required_observations,
  };
  const at = {
    file: "PAIR-X0.chromium.json",
    engine: "chromium",
    backend: "development",
    manifest: "f434df4a",
    row,
  };
  r.record.interval = "PAIR-X0:chromium:iv";
  assert.deepEqual(identityProblems(r.record, at), []);
  assert.ok(
    identityProblems({ ...r.record, caller: "recovery" }, at).some((p) =>
      /caller recovery, the matrix says ordinary/.test(p),
    ),
  );
  assert.ok(
    identityProblems({ ...r.record, local_work: true }, at).some((p) =>
      /local work true, the matrix says false/.test(p),
    ),
  );
});
test("refused (revision 27): the last page held with no staged page observed by it (fewer than two snapshot pages)", () => {
  const r = observedRecovery();
  r.record.observations = r.record.observations.filter(
    (o) => o.kind !== "recovery_staged_hidden",
  );
  r.record.required_observations = r.record.required_observations.filter(
    (k) => k !== "recovery_staged_hidden",
  );
  refuse(
    r,
    /recovery_final_held: no staged page was observed by the last one \(fewer than two snapshot pages\)/,
    "single",
  );
});

// ---- revision 28 (R28-DIAG.b; design assessment Q2/Q4): the interval reader judges what each page SHOWS, never the stored status ------
// Every case keeps the stored state correct (invalid cache, the recovery's generation, the old digest, staging) and changes only ONE
// reader's rendering at one barrier. Before revision 28 the reader's `hidden` accepted every such case because the cache was invalid.
// Parity: the live observer's own rules (pair-recovery.mjs) must reject the same sample — the two are written independently.
const SHAPES = {
  open: (g) => ({
    ...g,
    view: { kind: "displaying", account_id: ACCOUNT, state: null },
    root: { present: true, gated: false, mounted: true },
    placeholders: { present: 0, refreshing_visible: 0 },
  }),
  unavailable: () => ({ status: "unavailable", error: "evaluate failed" }),
  "unknown-kind": (g) => ({ ...g, view: { kind: "fenced" } }),
  "signed-out": (g) => ({
    ...g,
    view: { kind: "signed_out", account_id: null, state: null },
  }),
  "no-root": (g) => ({ ...g, root: { present: false } }),
  "placeholder-not-visible": (g) => ({
    ...g,
    view: { kind: "displaying", account_id: ACCOUNT, state: null },
    root: { present: true, gated: false, mounted: true },
    placeholders: { present: 1, refreshing_visible: 0 },
  }),
  "wrong-account": (g) => ({
    ...g,
    view: { kind: "displaying", account_id: "other-acct", state: null },
  }),
  "wrong-attachment": (g) => ({ ...g, attachment: "none" }),
  "no-document": (g) => ({ ...g, document: null }),
  "other-document": (g) => ({ ...g, document: `${g.document}-reloaded` }),
};
const SHAPE_EXPECTED = {
  open: /page shows account content/,
  unavailable: /incomplete sample: .*rendering is not observed \(unavailable\)/,
  "unknown-kind": /page shows account content/,
  "signed-out": /page shows account content/,
  "no-root": /incomplete sample: .*protected root is not observed/,
  "placeholder-not-visible": /page shows account content/,
  "wrong-account": /incomplete sample: .*displays another account/,
  "wrong-attachment": /incomplete sample: .*attached as none/,
  "no-document": /incomplete sample: .*names no document/,
  "other-document": /document is not the one observed at the invalidation/,
};
/** Where a barrier's sample sits in the record. */
const SAMPLES = {
  invalidated: (r, who) => obs(r, "recovery_invalidated").detail[who],
  staged: (r, who) => obs(r, "recovery_staged_hidden").detail[who],
  "held page": (r, who) => obs(r, "recovery_final_held").detail.pages[0][who],
  final: (r, who) => obs(r, "recovery_final_held").detail[who],
};
for (const caller of ["ordinary", "recovery"])
  for (const who of ["leader", "follower"])
    for (const [at, sampleOf] of Object.entries(SAMPLES))
      for (const [shape, change] of Object.entries(SHAPES)) {
        if (shape === "other-document" && at === "invalidated") continue;
        test(`refused (revision 28, ${caller}): the ${who} ${shape} at the ${at}, every stored field correct`, () => {
          const r = observedRecovery({
            caller,
            rearmed: caller === "recovery",
          });
          const sample = sampleOf(r, who);
          // Parity: the live observer's rules accept the healthy sample and reject the changed one.
          assert.deepEqual(
            hiddenProblems(sample, { caller, what: "x" }),
            [],
            "healthy before the change",
          );
          sample.rendering = change(sample.rendering);
          if (shape !== "other-document")
            assert.ok(
              hiddenProblems(sample, { caller, what: "x" }).length > 0 ||
                ["wrong-account", "wrong-attachment", "no-document"].includes(
                  shape,
                ),
              "the live observer also rejects it",
            );
          refuse(r, SHAPE_EXPECTED[shape], `${caller} ${who} ${shape} ${at}`);
        });
      }
test("refused (revision 28, recovery caller): a displaying page behind the refreshing placeholder is not the fenced recovery's hidden state", () => {
  const r = observedRecovery({ caller: "recovery", rearmed: true });
  obs(r, "recovery_staged_hidden").detail.follower.rendering =
    RENDER.refreshing("follower");
  refuse(
    r,
    /follower's page shows account content while the snapshot is staged/,
    "displaying fenced",
  );
});
test("accepted (revision 28, ordinary caller): the neutral state over a gated tree is also hidden", () => {
  const r = observedRecovery();
  obs(r, "recovery_staged_hidden").detail.follower.rendering =
    RENDER.neutral("follower");
  accept(r);
});
test("refused (revision 28): a recovery observation of the earlier contract (revision 27's gate/view fields, no rendering) is incomplete, never upgraded", () => {
  const r = observedRecovery();
  const o = obs(r, "recovery_staged_hidden");
  delete o.detail.schema;
  for (const who of ["leader", "follower"]) {
    delete o.detail[who].rendering;
    Object.assign(o.detail[who], { gate: "refreshing", view: "displaying" });
  }
  refuse(
    r,
    /recovery_staged_hidden: made under the observation contract null/,
    "old contract",
  );
  refuse(
    r,
    /recovery_staged_hidden: an incomplete sample: leader's rendering is not observed \(missing\)/,
    "old samples",
  );
});
test("refused (revision 28): the interval names no observed reader account", () => {
  const r = observedRecovery();
  delete r.record.reader_account;
  refuse(r, /names no observed reader account/, "no account");
});
test("refused (revision 28): both readers consistently of ANOTHER account than the interval's", () => {
  const r = observedRecovery();
  r.record.reader_account = "someone-else";
  refuse(r, /is not a sample of the account someone-else/, "wrong account");
});
test("refused (revision 28): the follower reports the leader's own document", () => {
  const r = observedRecovery();
  for (const o of r.record.observations.filter((x) => x.detail?.follower))
    o.detail.follower.rendering.document = "leader-document";
  for (const p of obs(r, "recovery_final_held").detail.pages)
    p.follower.rendering.document = "leader-document";
  refuse(r, /follower is the leading page's own document/, "same document");
});
test("refused (revision 28): auth fences that were not read", () => {
  const r = observedRecovery();
  obs(r, "recovery_invalidated").detail.follower.fenced = null;
  refuse(r, /follower's auth fences are not observed/, "fences");
});
test("refused (revision 28, C4): an intermediate held page missing from the record", () => {
  const r = observedRecovery();
  obs(r, "recovery_final_held").detail.pages.shift();
  refuse(r, /are not the snapshot pages/, "missing page");
});
test("refused (revision 28, C4): no held pages recorded", () => {
  const r = observedRecovery();
  delete obs(r, "recovery_final_held").detail.pages;
  refuse(r, /held snapshot pages are not recorded/, "no pages");
});
test("refused (revision 28, C4): an intermediate page's follower with the old cache valid", () => {
  const r = observedRecovery();
  obs(r, "recovery_final_held").detail.pages[0].follower.cache_status = "valid";
  refuse(r, /live cache is not the old hidden one at page/, "page cache");
});
// The rendered settlement (C5).
test("refused (revision 28, C5): the rendered settlement missing (data activation alone)", () => {
  const r = observedRecovery();
  r.record.observations = r.record.observations.filter(
    (o) => o.kind !== "recovery_rendered",
  );
  refuse(r, /required observation recovery_rendered is missing/, "no rendered");
});
for (const caller of ["ordinary", "recovery"])
  for (const who of ["leader", "follower"]) {
    test(`refused (revision 28, C5, ${caller}): the ${who} never shown (still behind the gate) at the rendered settlement`, () => {
      const r = observedRecovery({ caller, rearmed: caller === "recovery" });
      const sample = obs(r, "recovery_rendered").detail[who];
      assert.deepEqual(shownProblems(sample), [], "healthy before the change");
      sample.rendering = RENDER.refreshing(who);
      assert.ok(shownProblems(sample).length > 0, "parity");
      refuse(
        r,
        new RegExp(`${who}'s page does not show the recovered cache`),
        "not shown",
      );
    });
    test(`refused (revision 28, C5, ${caller}): the ${who}'s rendering unavailable at the rendered settlement`, () => {
      const r = observedRecovery({ caller, rearmed: caller === "recovery" });
      obs(r, "recovery_rendered").detail[who].rendering = {
        status: "unavailable",
        error: "x",
      };
      refuse(r, /recovery_rendered: an incomplete sample/, "unavailable");
    });
  }
test("refused (revision 28, C5, recovery caller): shown while the fence stands", () => {
  const r = observedRecovery({ caller: "recovery", rearmed: true });
  obs(r, "recovery_rendered").detail.follower.fenced = true;
  refuse(r, /follower shows the recovered cache while fenced/, "fenced shown");
});
test("refused (revision 28, C5): shown with another cache than the activated one", () => {
  const r = observedRecovery();
  obs(r, "recovery_rendered").detail.leader.cache_digest = "later";
  refuse(r, /shows another cache than the activated one/, "other cache");
});
test("refused (revision 28, C5): the rendered settlement before any data activation", () => {
  const r = observedRecovery();
  r.record.observations = r.record.observations.filter(
    (o) => o.kind !== "recovery_activated",
  );
  refuse(r, /no data activation was observed before it/, "no activation");
});
