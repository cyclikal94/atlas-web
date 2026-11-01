// WEB-09c revision 28 (R28-DIAG.a, family `segmented-sync-development-pairing`; design assessment C1/Q1): the SCHEDULE the real-410 diagnostic
// cases share at their chosen piece, kept apart from the browser (like pair-driver.mjs and pair-recovery.mjs) so the maintained composition
// itself — the continuation helper, the expiry control and XL0's reload hook — is qualified with deterministic stand-ins
// (pair-schedule.test.mjs). tests/pair/pair.development.spec.ts supplies the browser's, tap's and diagnostic control's IO.
//
// Revision 27's defect: `queueContinuation` owned the real token and awaited the control, which awaited XL0's `afterE` hook; that hook
// compared the reloaded request and the stored cursor with the spec's OUTER token, assigned only when `queueContinuation` RETURNED — after
// the hook it was waiting for. A valid continuation could never satisfy the poll. Now the continuation is an immutable CONTEXT, made from the
// held record before anything runs and handed to the control and to every hook it calls; a helper's return value is an outcome, never a
// prerequisite of a callback it awaits.
//
// Invariants (design assessment §Invariants 1, 2, 7): one non-empty, unmodified token from the target piece reaches every nested action
// before it executes; the piece is persisted and its continuation queued at the closed gate BEFORE the control; E−1 answers the same token,
// E is acknowledged, the session is live and nothing durable moved before any hook after E; the reload's own request (same cursor, queued
// after the reload began) is at the gate BEFORE the gate opens. A failing control or hook propagates and leaves the gate CLOSED (the owner's
// conclusion decides what happens to the attempt); nothing here opens it on failure.
import assert from "node:assert/strict";

/** The keys of the diagnostic `inspect` result the expiry's clock steps must leave unchanged (the durable baseline). */
export const UNCHANGED_BY_CLOCK = Object.freeze([
  "revision_clock",
  "accounts",
  "batches",
  "receipts_sha256",
  "resources_sha256",
  "sessions",
]);

/** The continuation context of a held piece: its own `next_cursor` (non-empty, verbatim) and that token's header. Frozen. */
export function continuationOf(record, headerOf) {
  const token = record?.next_cursor;
  if (typeof token !== "string" || token.length === 0)
    throw new Error(
      `the held piece ${record?.seq} carries no continuation to queue`,
    );
  return Object.freeze({ token, header: Object.freeze(headerOf(token)) });
}

/**
 * The shared schedule at the chosen piece. `io`: gate(open) (the tap's request gate); release() (the held piece to the client);
 * untilStored(ctx) (the piece persisted as the stage: the stored cursor is ctx.token and the stage's next index the header's);
 * untilGated(ctx) (the client's next request, with ctx.token, recorded at the closed gate and not forwarded). `control(ctx)` runs the
 * diagnostic command(s); the gate opens only after it resolves. Resolves with the context.
 */
export async function queueContinuation(io, record, control) {
  const ctx = continuationOf(record, io.headerOf);
  await io.gate(true);
  await io.release();
  await io.untilStored(ctx);
  await io.untilGated(ctx);
  await control(ctx);
  await io.gate(false);
  return ctx;
}

/**
 * The expiry schedule X0, XR0 and XL0 share: inspect, E−1 (the same token answered on the same session), E, the session live, inspect again
 * (nothing durable moved); then `afterE(ctx)`. `io`: receipt {sync_start, retention_seconds}; diagnostic(op, args) → {seq, result};
 * probeAt(label, token) → probe (labelled, bracketed by the caller's markers); sessionLive() → probe; controls, probes (the proof's records).
 * `hooks.beforeInspect(ctx)` runs before the durable baseline (XL0's local work); `hooks.afterE(ctx)` after E is acknowledged (XL0's reload).
 */
export function expiryControl(io, hooks = {}) {
  return async (ctx) => {
    const t = ctx.token;
    // The token was ISSUED at the frozen sync start: it expires at start + retention (read from the token, never altered).
    const E = ctx.header.expiry;
    assert.equal(
      E,
      io.receipt.sync_start + io.receipt.retention_seconds,
      "the continuation expires at the sync start plus the retention",
    );
    await hooks.beforeInspect?.(ctx);
    const before0 = await io.diagnostic("inspect");
    io.controls.inspect_before = before0.seq;
    const minus = await io.diagnostic("advance_clock", { time: E - 1 });
    io.controls.advance_e_minus_1 = minus.seq;
    assert.deepEqual(minus.result, { from: io.receipt.sync_start, to: E - 1 });
    // The SAME continuation on the SAME session one second before its expiry: still answered with its piece.
    const atMinus = await io.probeAt("x0-e-minus-1", t);
    assert.equal(atMinus.status, 200, "the token is valid at E−1");
    io.probes.e_minus_1 = atMinus;
    const atE = await io.diagnostic("advance_clock", { time: E });
    io.controls.advance_e = atE.seq;
    assert.deepEqual(atE.result, { from: E - 1, to: E });
    const live = await io.sessionLive();
    assert.equal(live.status, 200, "the session is live (wall time)");
    io.probes.session_after_e = live;
    const after = await io.diagnostic("inspect");
    io.controls.inspect_after_e = after.seq;
    for (const k of UNCHANGED_BY_CLOCK)
      assert.deepEqual(
        after.result[k],
        before0.result[k],
        `${k} unchanged by the clock steps`,
      );
    await hooks.afterE?.(ctx);
  };
}

/**
 * The reloaded page's own request (XL0): a /sync of the interval `label`, at the closed gate, with the context's cursor, requested at a
 * causal position AFTER the reload began (`begin`). The departed page's request (requested before) is never it.
 */
export const reloadedRequest = (records, { label, token, begin }) =>
  records.find(
    (r) =>
      r.label === label &&
      r.gated === true &&
      r.query?.cursor === token &&
      (r.j_request ?? 0) > begin,
  ) ?? null;

/**
 * XL0's `afterE` hook: the reload after E is acknowledged and before the gate opens. `io`: mark(name) → journal position; beforeReload()
 * (the trace kept); reload() (the page navigated away and booted again on the same page object); records() → the tap's /sync records;
 * stored() → the reloaded page's stored state; until(read, accept, what) (bounded poll; throws on its deadline); label; after(stored) (the
 * local-work barrier). Every comparison is with `ctx.token` — the continuation handed to the hook, never a value assigned later.
 */
export function reloadHook(io) {
  return async (ctx) => {
    const begin = await io.mark("reload_begin");
    await io.beforeReload();
    await io.reload();
    await io.mark("reload_end");
    // The reloaded page's own request, with the SAME stored continuation, queued at the gate after the reload began.
    const s = await io.until(
      async () =>
        reloadedRequest(await io.records(), {
          label: io.label,
          token: ctx.token,
          begin,
        })
          ? await io.stored()
          : null,
      (x) => x?.cursor === ctx.token,
      "the reloaded page asks again from the stored continuation",
    );
    await io.after(s);
  };
}
