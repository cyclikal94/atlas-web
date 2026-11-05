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
import { pickHeld } from "./pair-attempts.mjs";

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
 * untilGated(ctx) → the client's next request, with ctx.token, recorded at the closed gate and not forwarded; optional queued(request,
 * ctx) (revision 39: XL0 binds that request as the DEPARTED one, `refusalPair`, before the control runs). `control(ctx)` runs the
 * diagnostic command(s); the gate opens only after it resolves. Resolves with the context.
 */
export async function queueContinuation(io, record, control) {
  const ctx = continuationOf(record, io.headerOf);
  await io.gate(true);
  await io.release();
  await io.untilStored(ctx);
  const queued = await io.untilGated(ctx);
  await io.queued?.(queued, ctx);
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
 * causal position AFTER the reload began (`begin`). The departed page's request (requested before) is never it. Revision 39: more than one
 * such request is ambiguity and throws (never the first of several).
 */
export const reloadedRequest = (records, { label, token, begin }) => {
  const found = records.filter(
    (r) =>
      r.label === label &&
      r.gated === true &&
      typeof token === "string" &&
      token.length > 0 &&
      r.query?.cursor === token &&
      (r.j_request ?? 0) > begin,
  );
  if (found.length > 1)
    throw new Error(
      `requests ${found.map((r) => r.seq).join(",")} all claim to be the reloaded page's request: ambiguity, not a choice`,
    );
  return found[0] ?? null;
};

/**
 * XL0's `afterE` hook: the reload after E is acknowledged and before the gate opens. `io`: mark(name) → journal position; beforeReload()
 * (the trace kept); reload() (the page navigated away and booted again on the same page object); records() → the tap's /sync records;
 * stored() → the reloaded page's stored state; until(read, accept, what) (bounded poll; throws on its deadline); label; after(stored) (the
 * local-work barrier); optional reloaded(request, {begin, ctx}) (revision 39: XL0 binds the request as the LIVE one, `refusalPair`, while
 * the gate is still closed). Every comparison is with `ctx.token` — the continuation handed to the hook, never a value assigned later.
 */
export function reloadHook(io) {
  return async (ctx) => {
    const begin = await io.mark("reload_begin");
    await io.beforeReload();
    await io.reload();
    await io.mark("reload_end");
    // The reloaded page's own request, with the SAME stored continuation, queued at the gate after the reload began.
    let request = null;
    const s = await io.until(
      async () => {
        const found = reloadedRequest(await io.records(), {
          label: io.label,
          token: ctx.token,
          begin,
        });
        if (!found) return null;
        request = found;
        return await io.stored();
      },
      (x) => x?.cursor === ctx.token,
      "the reloaded page asks again from the stored continuation",
    );
    await io.reloaded?.(request, { begin, ctx });
    await io.after(s);
  };
}

/**
 * Revision 39 (R39-DIAG, family `segmented-sync-development-pairing`; design assessment C1/C2): XL0's TWO refusals of one continuation,
 * bound by identity and handled in that order whatever order their answers become available in.
 *
 * The defect: XL0 recognised the reloaded page's live 410 only once the departed page's 410 had been handled. The tap forwards both gated
 * requests when the gate opens without awaiting either answer, and the holding proxy holds an answer only once its upstream completed, so
 * request order says nothing about which answer is held first. When the live answer completed first, the driver released it as an ordinary
 * answer (no held-refusal observation, no hand-off), the client began its snapshot recovery, and the driver's next check of the stored
 * cursor failed against a model that had not seen the 410 (review run PAIR-XL0-chromium-370f3ae03603: request 237 completed at journal 1252,
 * departed request 231 at 1256).
 *
 * Invariants: the DEPARTED request D (queued at the closed gate before the clock steps, `queued`) and the LIVE request L (the reloaded page's
 * own request, queued after the reload began and still gated, `reloaded`) are bound before the gate opens, each with its tap seq, proxy
 * correlation and causal request position, distinct, of this interval, carrying the context's continuation and unforwarded. The selection
 * (`select`, given to the driver) then chooses ONLY D while D is unaccounted — a held L is left untouched, never released, whatever its
 * arrival — and only L after D was handled; any other held answer, a duplicate, a mis-joined entry or a D still held after its release
 * fails the drive. `answer` (the case's hook) requires both answers to be the server's own, unaltered 410 resync_required: D is released
 * to nobody (`{delivered: false}`, its real downstream outcome kept by the driver's ledger), then L, while still HELD, is given to
 * `hooks.live` (the held-refusal observation and follower) and the drive hands off at it. Nothing is waited for by a clock here; the
 * driver's own bounded deadline applies. A failing hook or release propagates and leaves L held for the failure's owner.
 */
export function refusalPair({ label }) {
  if (typeof label !== "string" || label.length === 0)
    throw new Error("a refusal pair belongs to one named interval");
  let token = null;
  let departed = null;
  let live = null;
  let begin = null;
  let accounted = false;
  let handedOff = false;
  const fail = (what) => {
    throw new Error(`XL0 refusal pair: ${what}`);
  };
  const bindable = (r, ctx, what) => {
    if (!(Number.isInteger(r?.seq) && Number.isInteger(r?.proxy_id)))
      fail(`${what} carries no tap seq and proxy correlation`);
    if (r.label !== label)
      fail(`${what} ${r.seq} belongs to ${r.label}, not ${label}`);
    if (r.gated !== true) fail(`${what} ${r.seq} was not queued at the gate`);
    if (
      !(typeof ctx?.token === "string" && ctx.token.length > 0) ||
      r.query?.cursor !== ctx.token
    )
      fail(`${what} ${r.seq} does not carry the continuation`);
    if (
      r.t_gate_open !== undefined ||
      !(r.status === null || r.status === undefined)
    )
      fail(`${what} ${r.seq} was already forwarded`);
    if (!Number.isInteger(r.j_request))
      fail(`${what} ${r.seq} has no causal request position`);
    return Object.freeze({
      seq: r.seq,
      proxy_id: r.proxy_id,
      j_request: r.j_request,
    });
  };
  const which = (record) => {
    if (record?.seq === departed.seq) return ["departed", departed];
    if (record?.seq === live.seq) return ["live", live];
    return [null, null];
  };
  const select = {
    pick(heldIds, records) {
      if (departed === null && live === null) return pickHeld(heldIds, records);
      if (live === null)
        fail("an answer is selected while only the departed request is bound");
      if (handedOff) fail("an answer is selected after the hand-off");
      const ids = [...heldIds];
      const others = ids.filter(
        (id) => id !== departed.proxy_id && id !== live.proxy_id,
      );
      if (others.length > 0)
        fail(
          `held proxy entries ${others.join(",")} are neither the departed (${departed.proxy_id}) nor the live (${live.proxy_id}) request`,
        );
      if (accounted && ids.includes(departed.proxy_id))
        fail(
          `the departed answer (proxy ${departed.proxy_id}) is still held after its release`,
        );
      const want = accounted ? live : departed;
      if (!ids.includes(want.proxy_id)) return null;
      const picked = pickHeld([want.proxy_id], records);
      if (picked && picked.record.seq !== want.seq)
        fail(
          `proxy entry ${want.proxy_id} is joined to tap record ${picked.record.seq}, not the bound ${want.seq}`,
        );
      return picked;
    },
    waiting() {
      if (live === null) return "nothing (the pair is not bound)";
      const want = accounted ? ["live", live] : ["departed", departed];
      return `the ${want[0]} request's answer (tap ${want[1].seq}, proxy ${want[1].proxy_id})`;
    },
  };
  return {
    select,
    /** `queueContinuation`'s `queued`: the departed page's request, at the closed gate before the control. */
    queued(record, ctx) {
      if (departed !== null) fail("the departed request is bound twice");
      departed = bindable(record, ctx, "the departed request");
      token = ctx.token;
    },
    /** `reloadHook`'s `reloaded`: the reloaded page's own request, at the still-closed gate after the reload began. */
    reloaded(record, { begin: at, ctx }) {
      if (departed === null)
        fail("the live request is bound before the departed one");
      if (live !== null) fail("the live request is bound twice");
      if (ctx?.token !== token)
        fail("the live request is bound with another continuation");
      const l = bindable(record, ctx, "the reloaded request");
      if (
        !(Number.isInteger(at) && departed.j_request < at && at < l.j_request)
      )
        fail(
          `the requests are not on either side of the reload (departed ${departed.j_request}, reload ${at}, live ${l.j_request})`,
        );
      if (l.seq === departed.seq || l.proxy_id === departed.proxy_id)
        fail(`the reloaded request ${l.seq} is the departed one`);
      live = l;
      begin = at;
    },
    /** The bound identities (for the proof's checks and diagnosis); null until both are bound. */
    bound() {
      return live === null
        ? null
        : Object.freeze({ label, departed, live, reload_begin: begin });
    },
    /**
     * The case's held-answer hook once the pair is bound (undefined before: pieces before the schedule are ordinary). `hooks.lost(record)`
     * after D's release; `hooks.live(record)` while L is held (its rejection propagates, L stays held).
     */
    async answer({ record, release }, hooks) {
      if (live === null) {
        if (departed !== null)
          fail(
            `answer ${record?.seq} is handled while only the departed request is bound`,
          );
        return undefined;
      }
      const [role, bound] = which(record);
      if (role === null)
        fail(
          `answer ${record?.seq} is neither the departed (${departed.seq}) nor the live (${live.seq}) request`,
        );
      if (record.proxy_id !== bound.proxy_id)
        fail(
          `answer ${record.seq} came through proxy entry ${record.proxy_id}, not ${bound.proxy_id}`,
        );
      if (
        record.status !== 410 ||
        record.code !== "resync_required" ||
        record.delivered !== undefined ||
        record.dropped !== undefined
      )
        fail(
          `the ${role} request ${record.seq} was answered ${record.status} ${record.code ?? ""}, not the server's own 410 resync_required`,
        );
      if (role === "departed") {
        if (accounted)
          fail(`the departed answer ${record.seq} is handled twice`);
        await release();
        accounted = true;
        await hooks?.lost?.(record);
        return { delivered: false };
      }
      if (!accounted)
        fail(
          `the live refusal ${record.seq} is handled before the departed request ${departed.seq} was accounted`,
        );
      if (handedOff) fail(`the live refusal ${record.seq} is handled twice`);
      await hooks.live(record);
      handedOff = true;
      return {
        stop: true,
        reason:
          "the server's real 410 (expiry) to the reloaded page: the recovery is observed",
      };
    },
  };
}
