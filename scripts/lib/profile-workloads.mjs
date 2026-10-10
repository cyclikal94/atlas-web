// WEB-09a profiling workloads W1 to W7 (plan 7.3, handoff item H3): deterministic generators for `/sync` page bodies. Plain JavaScript
// with no dependency, so the same source runs in Node (the fixtures and their SHA-256 hashes are made by `pnpm profile:sync`) and in the
// fixture-only `/profile-harness` page on a device (which regenerates every workload and verifies it against the recorded hashes).
//
// Nothing here is random: every id, label and value is a function of its index, so a workload is byte-identical on every machine and
// every engine. A workload is a JSON TEXT (the response body), never an object graph; the page the engine reads is exactly these bytes.
//
//   W1  the approved dense-checklist batch: ONE batch of 800 `field` upserts, each a checklist of 100 items with 40 checked entries and
//       one-character labels (WEB-03 A:3445-3473: 7,402 bytes and 547 value nodes per checklist; 455,214 nodes and 5.83 MiB for 800)
//   W2  (not generated here) the largest valid batch the real server can produce, captured from the real `/sync` by the integration spec
//   W3  text-heavy: 800 `field` upserts of a 4,096-character text value
//   W4  multi-batch amplification: 10 batches rewriting the same 80 resources
//   W5  dense SNAPSHOT pages at each candidate `limit` (a snapshot page is not ordinary: only the processing path is shared with 09b)
//   W6  the largest single projection per kind (a 300-character label, the largest value the contract allows)
//   W7  malformed and oversize NEGATIVE CONTROLS, kept apart from the valid workloads
export const WORKLOAD_VERSION = 1;

export const uuid = (n) =>
  `00000000-0000-4000-8000-${Number(n).toString(16).padStart(12, "0")}`;

const KINDS = [
  "person",
  "field",
  "task",
  "execution",
  "occurrence",
  "progress",
  "list",
  "calendar_source",
  "event",
  "review",
  "reminder",
];

const projection = (n, kind, parent, label, value) => ({
  id: uuid(n),
  kind,
  parent_id: parent === null ? null : uuid(parent),
  label,
  value,
  version: 1,
  can_edit: true,
  policy_version: 1,
  archived: false,
});
const upsert = (resource) => ({ kind: "upsert", resource });

/** A page body: `batches` is an array of arrays of changes. */
export function pageBody(
  batches,
  nextCursor,
  hasMore = false,
  phase = "delta",
) {
  return JSON.stringify({
    phase,
    batches: batches.map((changes, i) => ({ revision: i + 1, changes })),
    next_cursor: nextCursor,
    has_more: hasMore,
  });
}

/** WEB-03's checklist: 100 items, 40 checked, one-character labels. `seed` keeps ids distinct between changes. */
export function checklistValue(seed, items = 100, checked = 40) {
  const list = Array.from({ length: items }, (_, i) => ({
    id: uuid(seed * 1000 + i + 1),
    label: "x",
  }));
  return {
    kind: "checklist",
    items: list,
    checked: list.slice(0, checked).map((item) => item.id),
  };
}

export const w1 = () =>
  pageBody(
    [
      Array.from({ length: 800 }, (_, c) =>
        upsert(
          projection(
            100_000 + c,
            "field",
            1,
            "Checklist",
            checklistValue(c + 1),
          ),
        ),
      ),
    ],
    "w1-cursor",
  );

/** A dense checklist page of `changes` changes with `items` items each (the P-2 shapes; W1 is 800 x 100). */
export const denseChecklistPage = (changes, items = 100) =>
  pageBody(
    [
      Array.from({ length: changes }, (_, c) =>
        upsert(
          projection(
            100_000 + c,
            "field",
            1,
            "Checklist",
            checklistValue(c + 1, items, Math.round(items * 0.4)),
          ),
        ),
      ),
    ],
    `dense-${changes}-${items}`,
  );

/** An ordinary page: `changes` small text fields (about 5 nodes of value each). */
export const ordinaryPage = (changes, round = 0) =>
  pageBody(
    [
      Array.from({ length: changes }, (_, c) =>
        upsert({
          ...projection(
            200_000 + c,
            c % 5 === 0 ? "task" : "field",
            1,
            `Item ${c}`,
            { kind: "text", text: `Note ${c} round ${round}` },
          ),
          version: round + 1,
        }),
      ),
    ],
    `ordinary-${changes}-${round}`,
  );

const WORDS = "water the plants, then fold the washing and call back ";
/** `n` characters of mixed ASCII and multi-byte text, deterministic in `seed`. */
export function textOf(n, seed) {
  let out = "";
  let i = seed;
  while (out.length < n) {
    out += WORDS.charAt(i % WORDS.length);
    if (i % 97 === 0) out += "é";
    if (i % 389 === 0) out += "日本";
    i += 7;
  }
  return out.slice(0, n);
}

export const w3 = () =>
  pageBody(
    [
      Array.from({ length: 800 }, (_, c) =>
        upsert(
          projection(300_000 + c, "field", 1, "Notes", {
            kind: "text",
            text: textOf(4096, c + 1),
          }),
        ),
      ),
    ],
    "w3-cursor",
  );

export const w4 = () =>
  pageBody(
    Array.from({ length: 10 }, (_, round) =>
      Array.from({ length: 80 }, (_, c) => ({
        ...upsert({
          ...projection(400_000 + c, "field", 1, `Rewritten ${c}`, {
            kind: "text",
            text: textOf(1500, round * 80 + c),
          }),
          version: round + 1,
        }),
      })),
    ),
    "w4-cursor",
  );

/** A snapshot page at `limit` batches of ordinary projections (the processing path only; 09b owns snapshot activation). */
export const w5 = (limit) =>
  pageBody(
    Array.from({ length: limit }, (_, b) =>
      Array.from({ length: 100 }, (_, c) =>
        upsert(
          projection(
            500_000 + b * 100 + c,
            KINDS[(b + c) % KINDS.length],
            null,
            `Snapshot ${b}.${c}`,
            { kind: "text", text: textOf(40, b * 100 + c) },
          ),
        ),
      ),
    ),
    `w5-${limit}`,
    false,
    "snapshot",
  );
export const W5_LIMITS = [1, 2, 4, 8, 16, 32, 64, 80];

/** The largest single projection per kind: a 300-character label and the largest value (8,192-byte whole value, depth within 24). */
export const w6 = () =>
  pageBody(
    [
      KINDS.map((kind, n) =>
        upsert(
          projection(600_000 + n, kind, null, textOf(300, n + 1), {
            kind: "text",
            text: textOf(4096, n + 1),
          }),
        ),
      ),
    ],
    "w6-cursor",
  );

/** W7: NEGATIVE controls. Each is a body the client must refuse; none is valid data. */
export const w7 = () => ({
  truncated: pageBody(
    [[upsert(projection(700_001, "field", 1, "x", null))]],
    "c",
  ).slice(0, 90),
  deep_value: pageBody(
    [
      [
        upsert(
          projection(
            700_002,
            "field",
            1,
            "deep",
            (() => {
              let v = { leaf: true };
              for (let i = 0; i < 40; i += 1) v = { n: v };
              return v;
            })(),
          ),
        ),
      ],
    ],
    "c",
  ),
  unknown_field: pageBody(
    [[upsert({ ...projection(700_003, "field", 1, "x", null), extra: 1 })]],
    "c",
  ),
  bad_kind: pageBody(
    [
      [
        upsert({
          ...projection(700_004, "field", 1, "x", null),
          kind: "nonsense",
        }),
      ],
    ],
    "c",
  ),
  // A raw control character inside a string is not JSON: the scanner refuses it. (An ESCAPED lone surrogate is valid JSON and is
  // accepted, so it is not a negative control: see the report.)
  raw_control_char: pageBody(
    [[upsert(projection(700_005, "field", 1, "tab\u0001inside", null))]],
    "c",
  ).replace("\\u0001", "\u0001"),
  oversize_change: pageBody(
    [
      [
        upsert(
          projection(700_006, "field", 1, "big", {
            kind: "text",
            text: "z".repeat(70_000),
          }),
        ),
      ],
    ],
    "c",
  ),
});

/** Every valid workload by name (W2 and W5 limits are separate). */
export const VALID = {
  W1: w1,
  W3: w3,
  W4: w4,
  W6: w6,
};

/** SHA-256 of a string's UTF-8 bytes, lower-case hex. Works in Node and in a secure-context browser. */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Value nodes as WEB-03 counts them: every object, array and scalar, and every object KEY, anywhere in the document. */
export function countNodes(value) {
  if (Array.isArray(value))
    return 1 + value.reduce((n, item) => n + countNodes(item), 0);
  if (value !== null && typeof value === "object")
    return (
      1 + Object.entries(value).reduce((n, [, v]) => n + 1 + countNodes(v), 0)
    );
  return 1;
}

/** Every workload as `{ name, body }` (strings), in a fixed order: what the hashes cover. */
export function allWorkloads() {
  const out = [
    { name: "W1", body: w1() },
    { name: "W3", body: w3() },
    { name: "W4", body: w4() },
    ...W5_LIMITS.map((limit) => ({
      name: `W5-limit-${limit}`,
      body: w5(limit),
    })),
    { name: "W6", body: w6() },
  ];
  for (const [name, body] of Object.entries(w7()))
    out.push({ name: `W7-${name}`, body });
  return out;
}
