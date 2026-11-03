// WEB-09c revision 30 (R30-DIAG; design assessment C1/Q1): the maintained CAPTURE CONTRACT (pair-capture.mjs) on its own. The in-page
// function runs against doubled `window`/`document` globals (and once re-parsed from its own source, as `page.evaluate` serialises it);
// the stored reads are doubled. Each outcome is a raw bracket result — no combination is invented (e.g. a storage-only change never
// reports an unknown fence).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTH_BRACKETS,
  captureInPage,
  ENDPOINT_FIELDS,
  recoverySample,
  renderingOf,
  STAMP_FIELDS,
  STORAGE_BRACKETS,
  storageBracket,
} from "./pair-capture.mjs";

const ACCOUNT = "acct-reader";
const FENCE = { kind: "invalid_session", seq: 8 };
/**
 * A doubled page. `fences(i)` → the account's fence entries at the i-th auth read (or throws); `onRead(i, dom)` runs as that read returns
 * (it may change the DOM: anything the capture sees is decided by the one synchronous turn between the reads). `dom` is mutable.
 */
function page({
  fences = () => [],
  onRead = () => undefined,
  dom = {},
  view = { kind: "displaying", account_id: ACCOUNT, state: null },
  attachment = "leader",
  notice = null,
  noView = false,
  evaluateThrows = null,
  fn = captureInPage,
} = {}) {
  const state = {
    gated: false,
    mounted: true,
    placeholders: [],
    present: true,
    ...dom,
  };
  return {
    state,
    evaluate: async (callback, account) => {
      if (evaluateThrows) throw new Error(evaluateThrows);
      assert.equal(callback, captureInPage, "the maintained page function");
      let reads = 0;
      const saved = { w: globalThis.window, d: globalThis.document };
      globalThis.window = {
        __s: noView ? undefined : { view: { get: () => ({ ...view }) } },
        __atlasFixture: {
          session: {
            leader: () => (attachment === null ? null : { attachment, notice }),
            readRecords: async () => {
              const i = reads;
              reads += 1;
              const entries = fences(i);
              onRead(i, state);
              return { auth_state: { fences: { [account]: entries } } };
            },
          },
        },
      };
      globalThis.document = {
        getElementById: (id) =>
          id === "protected-root" && state.present
            ? {
                hasAttribute: (k) => k === "inert" && state.gated,
                getAttribute: (k) =>
                  k === "aria-hidden" && state.gated ? "true" : null,
                get childElementCount() {
                  return state.mounted ? 1 : 0;
                },
                querySelectorAll: () =>
                  state.placeholders.map((p) => ({
                    getBoundingClientRect: () => ({ width: 10, height: 10 }),
                    getAttribute: () => p.kind,
                    ...(p.visible === undefined
                      ? {}
                      : { checkVisibility: () => p.visible }),
                  })),
              }
            : null,
      };
      globalThis.getComputedStyle = () => ({
        visibility: "visible",
        opacity: "1",
      });
      try {
        return await fn(account);
      } finally {
        globalThis.window = saved.w;
        globalThis.document = saved.d;
        delete globalThis.getComputedStyle;
      }
    },
  };
}
const STORED = {
  incarnation: "incarnation-1",
  composition_seq: 10,
  cache_status: "invalid",
  cache_digest: "old",
  applied_revision: 8,
  cursor: null,
  phase: "snapshot",
  delta_stage: null,
  staged: 0,
  recovery_generation: 6,
  staging_rows: 3,
  staging_generations: [6],
};

test("R30 Q1: the brackets' outcomes are the contract's (pair-recovery.mjs refuses any other)", () => {
  assert.deepEqual([...AUTH_BRACKETS], ["stable", "changed", "unavailable"]);
  assert.deepEqual(
    [...STORAGE_BRACKETS],
    ["stable", "changed", "replaced", "unavailable"],
  );
  assert.ok(
    !STAMP_FIELDS.includes("incarnation"),
    "a lifetime change is a replacement, never a change",
  );
});
test("R30 Q1: the same fences at both reads — a stable auth bracket with its fence (fenced and unfenced)", async () => {
  for (const entries of [[FENCE], []]) {
    const out = await renderingOf(page({ fences: () => entries }), ACCOUNT);
    assert.deepEqual(out.auth, { status: "stable" });
    assert.equal(out.fenced, entries.length > 0);
    assert.equal(out.rendering.status, "observed");
    assert.equal(typeof out.rendering.document, "string");
  }
});
test("R30 Q1: changed fence entries (one entry REPLACED by another, the same count) — changed, the fence indeterminate", async () => {
  const out = await renderingOf(
    page({ fences: (i) => [{ ...FENCE, seq: 8 + i }] }),
    ACCOUNT,
  );
  assert.equal(out.auth.status, "changed");
  assert.match(out.auth.reason, /auth fences changed during the capture/);
  assert.equal(out.fenced, null);
  assert.equal(
    out.rendering.status,
    "observed",
    "the rendering stands on its own",
  );
});
test("R30 Q1: the capture is ONE synchronous turn between the two fence reads (the DOM changed by each read's return is seen as at the turn)", async () => {
  // The first read gates the root as it returns; the second lifts it again before it returns. Captured before the first or after the
  // second read, the root would be lifted.
  const p = page({
    fences: () => [],
    onRead: (i, s) => {
      s.gated = i === 0;
    },
  });
  const out = await renderingOf(p, ACCOUNT);
  assert.equal(out.rendering.root.gated, true);
  assert.equal(p.state.gated, false);
  assert.deepEqual(out.auth, { status: "stable" });
});
test("R30 Q1: unreadable fences (before or after) — the auth bracket UNAVAILABLE, never changed; the rendering stands", async () => {
  for (const at of [0, 1]) {
    const out = await renderingOf(
      page({
        fences: (i) => {
          if (i === at) throw new Error("the auth store is closed");
          return [];
        },
      }),
      ACCOUNT,
    );
    assert.deepEqual(out.auth, {
      status: "unavailable",
      error: "the auth store is closed",
    });
    assert.equal(out.fenced, null);
    assert.equal(out.rendering.status, "observed");
  }
});
test("R30 Q1: an unavailable rendering (no session view; no data attachment) keeps its STABLE auth bracket — a separate outcome", async () => {
  for (const [opts, error] of [
    [{ noView: true }, "the session view is not readable"],
    [{ view: { kind: 7 } }, "the session view is not readable"],
    [{ attachment: null }, "the page's data attachment is not readable"],
  ]) {
    const out = await renderingOf(
      page({ fences: () => [FENCE], ...opts }),
      ACCOUNT,
    );
    assert.deepEqual(out.rendering, { status: "unavailable", error });
    assert.deepEqual(out.auth, { status: "stable" });
    assert.equal(out.fenced, true);
    assert.equal(out.notice, null);
  }
});
test("R30 Q1: a page that cannot be evaluated — rendering AND auth unavailable (never `coherent: true` as a proxy)", async () => {
  const out = await renderingOf(
    page({ evaluateThrows: "Target closed" }),
    ACCOUNT,
  );
  assert.deepEqual(out, {
    rendering: { status: "unavailable", error: "Target closed" },
    notice: null,
    fenced: null,
    auth: { status: "unavailable", error: "Target closed" },
  });
  assert.ok(!("coherent" in out));
});
test("R30 Q1: visibility — checkVisibility when present, computed style otherwise; only refreshing placeholders count", async () => {
  const out = await renderingOf(
    page({
      dom: {
        placeholders: [
          { kind: "refreshing", visible: true },
          { kind: "refreshing", visible: false },
          { kind: "refreshing" },
          { kind: "floor", visible: true },
        ],
      },
    }),
    ACCOUNT,
  );
  assert.deepEqual(out.rendering.placeholders, {
    present: 4,
    refreshing_visible: 2,
  });
  const none = await renderingOf(page({ dom: { present: false } }), ACCOUNT);
  assert.deepEqual(none.rendering.root, {
    present: false,
    gated: false,
    mounted: false,
  });
});
test("R30 Q1: the page function is self-contained (re-parsed from its own source, as page.evaluate serialises it)", async () => {
  // A copy built from the source text alone (no module scope reachable), run with the same doubles, gives the same capture.
  const reparsed = new Function(`return (${captureInPage.toString()})`)();
  const q = page({ fences: () => [FENCE], fn: reparsed });
  const again = await q.evaluate(captureInPage, ACCOUNT);
  assert.deepEqual(Object.keys(again).sort(), [
    "auth",
    "fenced",
    "notice",
    "rendering",
  ]);
  assert.deepEqual(again.auth, { status: "stable" });
  assert.equal(again.fenced, true);
  assert.equal(again.rendering.status, "observed");
});
test("R30 Q1: the storage bracket — unchanged; composition-only; a status/staging/revision transition; each stamp field on its own", () => {
  assert.deepEqual(storageBracket(STORED, { ...STORED }), { status: "stable" });
  assert.deepEqual(storageBracket(STORED, { ...STORED, composition_seq: 11 }), {
    status: "changed",
    fields: ["composition_seq"],
    before: { composition_seq: 10 },
    after: { composition_seq: 11 },
  });
  const commit = storageBracket(STORED, {
    ...STORED,
    composition_seq: 12,
    cache_status: "valid",
    cache_digest: "new",
    applied_revision: 12,
    staging_rows: 0,
    staging_generations: [],
  });
  assert.equal(commit.status, "changed");
  assert.deepEqual(commit.fields, [
    "composition_seq",
    "cache_status",
    "cache_digest",
    "applied_revision",
    "staging_rows",
    "staging_generations",
  ]);
  assert.equal(commit.before.cache_status, "invalid");
  assert.equal(commit.after.cache_status, "valid");
  const values = {
    composition_seq: 99,
    cache_status: "valid",
    cache_digest: "x",
    applied_revision: 1,
    cursor: "c",
    phase: "delta",
    delta_stage: { revision: 1, next_index: 0 },
    staged: 4,
    recovery_generation: 7,
    staging_rows: 9,
    staging_generations: [6, 7],
  };
  for (const k of STAMP_FIELDS)
    assert.deepEqual(
      storageBracket(STORED, { ...STORED, [k]: values[k] }).fields,
      [k],
      k,
    );
  // Rows and local work are not part of the stamp (the row-bearing read's second read never asks for them).
  assert.deepEqual(storageBracket({ ...STORED, rows: [1] }, { ...STORED }), {
    status: "stable",
  });
});
test("R30 Q1: the storage bracket — a failed second read, no database, another incarnation (identity, never a change)", () => {
  assert.deepEqual(storageBracket(STORED, null, "aborted"), {
    status: "unavailable",
    reason: "the stored state could not be read again: aborted",
  });
  assert.equal(storageBracket(STORED, null).status, "unavailable");
  assert.deepEqual(
    storageBracket(STORED, {
      ...STORED,
      incarnation: "incarnation-2",
      composition_seq: 0,
    }),
    {
      status: "replaced",
      reason: "the account database is another incarnation at the second read",
      incarnation_after: "incarnation-2",
    },
  );
});
test("R30 Q1: the composed sample keeps BOTH brackets — both changed, each with its own reason; the stored fields are the first read's", async () => {
  let n = 0;
  const out = await recoverySample(
    {
      stored: async (rows) => {
        n += 1;
        return n === 1
          ? { ...STORED, ...(rows ? { rows: ["r"] } : {}) }
          : { ...STORED, composition_seq: 11 };
      },
      rendering: () =>
        renderingOf(page({ fences: (i) => (i === 0 ? [FENCE] : []) }), ACCOUNT),
    },
    { reader: "follower", page: "follower-page", account: ACCOUNT, rows: true },
  );
  assert.equal(n, 2);
  assert.equal(out.composition_seq, 10);
  assert.deepEqual(out.rows, ["r"]);
  assert.equal(out.reader, "follower");
  assert.equal(out.fenced, null);
  assert.equal(out.capture.auth.status, "changed");
  assert.equal(out.capture.storage.status, "changed");
  assert.deepEqual(out.capture.storage.fields, ["composition_seq"]);
});
test("R30 Q1: the composed sample — a stable fence over a storage-only change stays STABLE and fenced (the R30 composition)", async () => {
  let n = 0;
  const out = await recoverySample(
    {
      stored: async () => {
        n += 1;
        return { ...STORED, composition_seq: 10 + n - 1 };
      },
      rendering: () => renderingOf(page({ fences: () => [FENCE] }), ACCOUNT),
    },
    { reader: "leader", page: "leader-page", account: ACCOUNT },
  );
  assert.deepEqual(out.capture.auth, { status: "stable" });
  assert.equal(out.fenced, true);
  assert.equal(out.capture.storage.status, "changed");
  assert.equal(out.rendering.view.kind, "displaying");
});
test("R30 Q1: the composed sample — no database at the first read throws; a failing or empty second read is reported, not thrown", async () => {
  await assert.rejects(
    recoverySample(
      {
        stored: async () => null,
        rendering: async () => assert.fail("never captured"),
      },
      { reader: "leader", page: "p", account: ACCOUNT },
    ),
    /the leader has no account database/,
  );
  for (const [second, status] of [
    [() => Promise.reject(new Error("aborted")), "unavailable"],
    [async () => null, "unavailable"],
  ]) {
    let n = 0;
    const out = await recoverySample(
      {
        stored: async () => {
          n += 1;
          return n === 1 ? { ...STORED } : second();
        },
        rendering: () => renderingOf(page(), ACCOUNT),
      },
      { reader: "leader", page: "p", account: ACCOUNT },
    );
    assert.equal(out.capture.storage.status, status);
  }
  const malformed = await recoverySample(
    { stored: async () => ({ ...STORED }), rendering: async () => ({}) },
    { reader: "leader", page: "p", account: ACCOUNT },
  );
  assert.equal(
    malformed.capture.auth,
    null,
    "a malformed rendering result has no auth bracket (the observer refuses it)",
  );
});

// Revision 31 (R31-DIAG; design assessment C3, DA31-ENDPOINT): the second read is a coherent transaction of its own and is RETAINED.
test("R31 Q1: the composed sample retains the SECOND stored transaction (incarnation and every stamp field), never rows or local work", async () => {
  assert.deepEqual(ENDPOINT_FIELDS, ["incarnation", ...STAMP_FIELDS]);
  const asked = [];
  let n = 0;
  const out = await recoverySample(
    {
      stored: async (rows, local) => {
        asked.push([rows, local]);
        n += 1;
        return n === 1
          ? { ...STORED, rows: ["r"], local: { drafts: [] } }
          : {
              ...STORED,
              cache_digest: "second-digest",
              composition_seq: 11,
              rows: ["leaked"],
              local: { drafts: ["x"] },
            };
      },
      rendering: () => renderingOf(page(), ACCOUNT),
    },
    {
      reader: "leader",
      page: "p",
      account: ACCOUNT,
      rows: true,
      local: ["l1"],
    },
  );
  assert.deepEqual(
    asked,
    [
      [true, ["l1"]],
      [false, null],
    ],
    "the second read asks for neither rows nor local work",
  );
  assert.ok(out.stored_after, "the second transaction is retained");
  assert.deepEqual(Object.keys(out.stored_after), [...ENDPOINT_FIELDS]);
  assert.equal(out.stored_after.cache_digest, "second-digest");
  assert.equal(out.stored_after.composition_seq, 11);
  assert.equal(out.stored_after.incarnation, STORED.incarnation);
  assert.ok(!("rows" in out.stored_after) && !("local" in out.stored_after));
  assert.equal(
    out.cache_digest,
    STORED.cache_digest,
    "the sample's own fields stay the first read's",
  );
  assert.deepEqual(out.rows, ["r"]);
});
test("R31 Q1: no second transaction is retained when the second read failed or found no database (never the first copied in)", async () => {
  for (const second of [
    () => Promise.reject(new Error("aborted")),
    async () => null,
  ]) {
    let n = 0;
    const out = await recoverySample(
      {
        stored: async () => {
          n += 1;
          return n === 1 ? { ...STORED } : second();
        },
        rendering: () => renderingOf(page(), ACCOUNT),
      },
      { reader: "leader", page: "p", account: ACCOUNT },
    );
    assert.equal(out.stored_after, null);
    assert.equal(out.capture.storage.status, "unavailable");
  }
});
