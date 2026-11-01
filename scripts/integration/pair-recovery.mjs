// WEB-09c revision 27 (R27-DIAG.b, family `segmented-sync-development-pairing`; design assessment C2): the RECOVERY OBSERVER of the real-410
// diagnostic cases, kept apart from the browser (like pair-driver.mjs) so the maintained code itself is qualified with deterministic worlds
// (pair-recovery.test.mjs). tests/pair/support.ts supplies the browser's IO.
//
// Revision 26 released the whole hold at the server's 410 and polled for the final valid cache: a temporary exposure, a partial snapshot or
// an un-abandoned stage followed by correct final content passed. Now the interval's hold STAYS ARMED after the refusal (the driver released
// only the 410 itself), and every snapshot answer of the recovery is held, observed and released one at a time:
//
//   1. the FIRST held snapshot answer proves the client processed the refusal (it committed the invalidation before asking): the leader
//      and an independent follower page (its own connection) read the invalidated state — cache not valid and hidden, cursor null, the
//      delta stage and both stagings empty, a NEW recovery generation, the old live cache physically untouched; for the RECOVERY caller
//      (W24, server restart) also the snapshot phase, the job's own resync_required notice and the fence still in force; an ordinary caller
//      (W18) is not fenced. `recovery_invalidated`.
//   2. at the next held page (one or more pages are staged): both readers see staged rows of that one generation only, the live cache still
//      the old one and still hidden. `recovery_staged_hidden`. Every later held page is checked by BOTH readers (revision 28; rows never go
//      backwards, the generation and the old cache stand, still hidden).
//   3. the LAST snapshot page (has_more false) held: still hidden, before its release. `recovery_final_held`. A recovery of fewer than two
//      snapshot pages cannot show hidden staging and FAILS (the fixture must produce at least two; nothing is lowered to force it).
//   4. released: the leader's reads until the commit must each be the staged state or the complete one — anything in between (a valid cache
//      with rows still staged, a changed cache before validity) is a SPLIT activation and fails. Then the follower reads the same complete
//      cache, the complete rows are judged by the caller's oracle, and `recovery_activated` (revision 27's `recovery_exposed`, renamed in
//      revision 28: it is the DATA activation, not what a page shows) binds the activating page.
//   5. (revision 28) `recovery_rendered`: both pages SHOW the recovered cache (see the rendering contract below).
// Network barriers show the state BETWEEN transactions; they cannot look inside one. Atomicity inside the W22/W23 transaction remains the
// existing native transaction controls' (qualified separately); this observer requires the evidence a split would leave between them.
import { createHash } from "node:crypto";
import { pickHeld } from "./pair-attempts.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Revision 28 (R28-DIAG.b, family `segmented-sync-development-pairing`; design assessment C2-C5): the stored cache status is NEVER evidence of
// what a page shows. Revision 27's `isHidden` was `cache_status !== "valid" || gate === "refreshing" || view !== "displaying"`: with the
// invalid status every invalidated/staged sample already satisfies it, so an open, displaying page passed, and a missing gate or view read
// (null) passed too. Now each reader carries a separate RENDERING observation of its own document (tests/pair/support.ts `renderingOf`,
// one page.evaluate): the session view as the session reports it (its real discriminant: booting, incompatible, signed_out, neutral,
// displaying with its account), the protected root (#protected-root: present, gated = inert AND aria-hidden="true", mounted = it has
// children), the VISIBLE refreshing placeholders of the cache gate inside that root, the page's data attachment (leader/follower) and a
// per-document identity. An unavailable observation is INCOMPLETE evidence and fails; it never counts as hidden.
//
// What counts as hidden (invariant 4 of the design assessment), judged from the rendering alone:
//   - the protected surface hidden: the root gated or the tree unmounted, with the session `neutral` (the person sees the neutral state,
//     no account content). This is the ONLY hidden shape for the fenced RECOVERY caller (its session is never displaying while fenced).
//   - for the ORDINARY caller also: the session displaying THIS account, the root lifted and mounted, and at least one VISIBLE refreshing
//     placeholder in it (CacheGate replaces its cache-sourced children with that placeholder; on /today every cache-sourced view is
//     inside the one CacheGate, all gates share one gate state). The floor (hidden, but not a recovery), signed_out, booting,
//     incompatible or an unknown kind never count.
// Shown (the rendered settlement after the activation, C5): displaying THIS account, the root lifted and mounted, no cache-gate placeholder
// at all. Data activation and rendered exposure are SEPARATE records: a complete valid cache while a recovery fence still stands is legal
// (§3.7.3: the data commits before the auth release); the page is then required to SHOW it once the session completes.

/** The contract of the recovery observations' readers (each observation's `detail.schema`); earlier observations are incomplete. */
export const OBSERVATION_SCHEMA = "web09c-recovery-observation/2";
export const RECOVERY_VIEW_KINDS = Object.freeze(["displaying", "neutral"]);
const isText = (v) => typeof v === "string" && v.length > 0;

/**
 * The problems that make a reader's sample INCOMPLETE (not an observation at all): the rendering unavailable or malformed, no document
 * identity, the wrong account, the reader's role not positively observed (the leader page attached as leader, the follower as follower),
 * the fences unavailable.
 */
export function observationProblems(r, { account }) {
  const p = [];
  const who = r?.reader ?? "a reader";
  const g = r?.rendering;
  if (g?.status !== "observed") {
    p.push(
      `${who}'s rendering was not observed (${g?.status ?? "missing"}${g?.error ? `: ${g.error}` : ""})`,
    );
    return p;
  }
  if (!isText(g.document)) p.push(`${who} names no document`);
  if (r.account !== account)
    p.push(`${who} read the account ${r.account}, not ${account}`);
  const role = r.reader === "leader" ? "leader" : "follower";
  if (g.attachment !== role)
    p.push(
      `${who}'s page is attached as ${g.attachment ?? "nothing"}, not ${role}`,
    );
  if (!g.view || !isText(g.view.kind))
    p.push(`${who}'s session view is not observed`);
  else if (g.view.kind === "displaying" && g.view.account_id !== account)
    p.push(`${who} displays the account ${g.view.account_id}, not ${account}`);
  if (g.root?.present !== true)
    p.push(`${who}'s protected root is not observed`);
  else if (
    typeof g.root.gated !== "boolean" ||
    typeof g.root.mounted !== "boolean"
  )
    p.push(`${who}'s protected root state is incomplete`);
  if (
    !g.placeholders ||
    !Number.isInteger(g.placeholders.refreshing_visible) ||
    !Number.isInteger(g.placeholders.present)
  )
    p.push(`${who}'s cache-gate placeholders are not observed`);
  if (typeof r.fenced !== "boolean")
    p.push(`${who}'s auth fences are not observed`);
  return p;
}

/**
 * The surface a complete rendering shows: `protected_hidden` (root gated or tree unmounted), `refreshing` (a visible refreshing placeholder
 * in the lifted root), `placeholder_not_visible` (a placeholder in the DOM that is not visible: never evidence of hiding), `shown` (the
 * displaying account with no placeholder) or `exposed` (a lifted tree with no placeholder outside a displaying session).
 */
export function surfaceOf(g) {
  const kind = g.view.kind;
  if (g.root.gated || !g.root.mounted) return "protected_hidden";
  if (g.placeholders.refreshing_visible > 0) return "refreshing";
  if (g.placeholders.present > 0) return "placeholder_not_visible";
  return kind === "displaying" ? "shown" : "exposed";
}

const complete = (r) =>
  r?.rendering?.status === "observed" &&
  isText(r.rendering.view?.kind) &&
  typeof r.rendering.root?.gated === "boolean" &&
  typeof r.rendering.root?.mounted === "boolean" &&
  Number.isInteger(r.rendering.placeholders?.refreshing_visible) &&
  Number.isInteger(r.rendering.placeholders?.present);

/** The problems of a rendering that must be HIDDEN (`what` names the barrier); an incomplete rendering is never hidden. */
export function hiddenProblems(r, { caller, what }) {
  if (!complete(r))
    return [`${r?.reader}'s rendering ${what} was not observed`];
  const g = r.rendering;
  const kind = g.view.kind;
  const surface = surfaceOf(g);
  if (!RECOVERY_VIEW_KINDS.includes(kind))
    return [`${r.reader}'s session is ${kind} ${what}, not a recovery state`];
  if (caller === "recovery") {
    if (kind !== "neutral")
      return [
        `the recovery caller's ${r.reader} is ${kind} ${what} (a fenced recovery is never displayed)`,
      ];
    return surface === "protected_hidden"
      ? []
      : [`${r.reader} shows the protected surface ${what} (${surface})`];
  }
  if (kind === "neutral")
    return surface === "protected_hidden"
      ? []
      : [`${r.reader} shows the protected surface ${what} (${surface})`];
  return surface === "protected_hidden" || surface === "refreshing"
    ? []
    : [`${r.reader} shows the account's cache content ${what} (${surface})`];
}

/** The problems of a complete rendering that must SHOW the recovered account (the rendered settlement). */
export function shownProblems(r) {
  if (!complete(r)) return [`${r?.reader}'s rendering was not observed`];
  const g = r.rendering;
  if (g.view.kind !== "displaying")
    return [`${r.reader}'s session is ${g.view.kind}, not displaying`];
  const surface = surfaceOf(g);
  return surface === "shown"
    ? []
    : [`${r.reader} does not show the recovered cache (${surface})`];
}

/** The problems of a reader's state right after the refusal was processed (`recovery_invalidated`). */
export function invalidatedProblems(
  r,
  { caller, oldDigest, refusalGeneration },
) {
  const p = [];
  if (r.cache_status === "valid")
    p.push(`${r.reader} still shows a valid cache`);
  if (r.cursor !== null) p.push(`${r.reader} keeps a cursor`);
  if (r.delta_stage !== null || r.staged !== 0)
    p.push(`${r.reader} keeps the abandoned delta stage`);
  if (r.staging_rows !== 0)
    p.push(`${r.reader} holds snapshot rows before the first page`);
  if (!(r.recovery_generation > refusalGeneration))
    p.push(`${r.reader} has no new recovery generation`);
  if (r.cache_digest !== oldDigest)
    p.push(`${r.reader}'s live cache changed before the snapshot`);
  p.push(...hiddenProblems(r, { caller, what: "while the cache is invalid" }));
  if (r.reader === "leader") {
    if (caller === "recovery") {
      if (r.phase !== "snapshot")
        p.push("the recovery caller's refusal did not restart the snapshot");
      if (r.notice?.reason !== "resync_required")
        p.push("the recovery job did not record its server restart");
      if (r.fenced !== true) p.push("the recovery caller is no longer fenced");
    } else if (r.fenced === true) p.push("an ordinary caller is fenced");
  }
  return p;
}

/** The problems of a reader's state while the snapshot is staged (`recovery_staged_hidden`, `recovery_final_held`, every later page). */
export function stagedProblems(
  r,
  { caller, oldDigest, generation, rowsAtLeast = 1 },
) {
  const p = [];
  if (!(Number.isInteger(r.staging_rows) && r.staging_rows >= rowsAtLeast))
    p.push(
      `${r.reader} holds ${r.staging_rows} staged rows, expected at least ${rowsAtLeast}`,
    );
  if (
    !(
      r.staging_generations?.length === 1 &&
      r.staging_generations[0] === generation
    )
  )
    p.push(`${r.reader}'s staged rows are not all of generation ${generation}`);
  if (r.recovery_generation !== generation)
    p.push(`${r.reader} moved to generation ${r.recovery_generation}`);
  if (r.cache_digest !== oldDigest)
    p.push(`${r.reader}'s live cache changed before the activation`);
  if (r.cache_status === "valid")
    p.push(`${r.reader} shows a valid cache before the last page`);
  p.push(
    ...hiddenProblems(r, { caller, what: "while the snapshot is staged" }),
  );
  if (caller === "recovery" && r.reader === "leader" && r.fenced !== true)
    p.push("the fence was cleared before the snapshot was complete");
  return p;
}

/** The complete STORED state after the activation (data only: what the page shows is `shownProblems`'s, recorded separately). */
export function activatedProblems(r, { oldDigest }) {
  const p = [];
  if (r.cache_status !== "valid")
    p.push(`${r.reader} does not hold a valid cache`);
  if (r.staging_rows !== 0 || r.delta_stage !== null || r.staged !== 0)
    p.push(`${r.reader} still holds staged rows after the activation`);
  if (r.cache_digest === oldDigest)
    p.push(`${r.reader} still holds the old cache`);
  return p;
}

/**
 * Observes one recovery to its rendered exposure. `io`: held(ruleId) → proxy ids; records() → the interval's tap /sync records;
 * release(ruleId, proxyId) → {released, outcomes}; read(reader, {rows}) → state with its `rendering` (reader "leader" | "follower");
 * recordRelease({proxy_id, outcome, reason}); observe(kind, atSeq, cacheDigest, detail); onPage?(kind, record, leader) (the case's own
 * per-barrier checks, e.g. its local work; it may throw); now(); sleep(ms). `o`: ruleId, caller ("ordinary" | "recovery"), account (the
 * reader's account: every sample must name it), refusal {seq, generation} (the hand-off's exchange and the generation stored when the
 * refusal was held), oldDigest, expectFinal(rows) → problems, bounds.
 *
 * Revision 28 (C4/C5): BOTH pages are read at EVERY held snapshot page (`recovery_final_held` carries them all as `pages`); each sample
 * must be a complete rendering of its own unchanged document, positively attached in its role, for the account; `recovery_activated` is
 * the atomic DATA activation; `recovery_rendered` is the later moment BOTH pages show the recovered cache (for the recovery caller, once
 * the fence is cleared: shown while fenced fails). Every sample until then is hidden or shown, never another state.
 * Resolves with {pages, final, rendered}; throws with a diagnosis on the first violation (the interval is then kept incomplete by its
 * owner). A read that throws is a failed observation, never a hidden one.
 */
export async function observeRecovery(io, o) {
  const {
    ruleId,
    caller,
    account,
    refusal,
    oldDigest,
    expectFinal,
    maxPages = 2000,
    heldTimeoutMs = 120_000,
    settleTimeoutMs = 120_000,
  } = o;
  if (!["ordinary", "recovery"].includes(caller))
    throw new Error(`unknown caller ${caller}`);
  if (!isText(account)) throw new Error("no reader account to observe");
  const fail = (what) => {
    throw new Error(`recovery observation: ${what}`);
  };
  const require = (problems, what) => {
    if (problems.length > 0) fail(`${what}: ${problems.join("; ")}`);
  };
  const documents = {};
  const read = async (who, opts) => {
    let r;
    try {
      r = await io.read(who, opts);
    } catch (error) {
      fail(`the ${who}'s read failed: ${String(error?.message ?? error)}`);
    }
    if (r?.reader !== who) fail(`a read of the ${who} returned ${r?.reader}`);
    require(observationProblems(r, {
      account,
    }), `an incomplete observation of the ${who}`);
    const doc = r.rendering.document;
    if (documents[who] === undefined) documents[who] = doc;
    else if (documents[who] !== doc)
      fail(
        `the ${who}'s document changed during the observation (reloaded or replaced)`,
      );
    const other = documents[who === "leader" ? "follower" : "leader"];
    if (other !== undefined && other === doc)
      fail("the follower is the leading page's own document");
    return r;
  };
  const both = async (opts) => [
    await read("leader", opts),
    await read("follower", opts),
  ];
  const handled = new Set();
  const pages = [];
  const heldPages = [];
  let generation = null;
  let rows = 0;
  let stagedSeen = false;
  const nextHeld = async () => {
    const deadline = io.now() + heldTimeoutMs;
    for (;;) {
      const held = (await io.held(ruleId)).filter((id) => !handled.has(id));
      const records = (await io.records()).filter((r) => r.seq > refusal.seq);
      const picked = pickHeld(held, records);
      if (picked) return picked;
      if (io.now() > deadline)
        fail(
          `no recovery answer was held within ${heldTimeoutMs} ms (after ${pages.length} pages)`,
        );
      await io.sleep(25);
    }
  };
  const release = async (proxyId, reason) => {
    handled.add(proxyId);
    const released = await io.release(ruleId, proxyId);
    if (released.released !== 1)
      fail(`releasing proxy entry ${proxyId} released ${released.released}`);
    const outcome = released.outcomes?.[0]?.outcome ?? null;
    await io.recordRelease({ proxy_id: proxyId, outcome, reason });
    if (outcome !== "delivered")
      fail(`the snapshot answer ${proxyId} was ${outcome}, not delivered`);
  };
  const detail = (extra) => ({ schema: OBSERVATION_SCHEMA, ...extra });
  for (;;) {
    const { record, proxyId } = await nextHeld();
    if (!(record.status === 200 && record.phase === "snapshot"))
      fail(
        `answer ${record.seq} held during the recovery is ${record.status} ${record.phase}, not a snapshot page`,
      );
    pages.push(record.seq);
    if (pages.length > maxPages) fail(`more than ${maxPages} snapshot pages`);
    const last = record.has_more === false;
    if (pages.length === 1) {
      const [leader, follower] = await both();
      for (const r of [leader, follower])
        require(invalidatedProblems(r, {
          caller,
          oldDigest,
          refusalGeneration: refusal.generation,
        }), `at the first snapshot page ${record.seq}`);
      if (follower.recovery_generation !== leader.recovery_generation)
        fail("the follower does not read the leader's generation");
      generation = leader.recovery_generation;
      await io.observe(
        "recovery_invalidated",
        record.seq,
        leader.cache_digest,
        detail({
          leader,
          follower,
          generation_at_refusal: refusal.generation,
        }),
      );
      await io.onPage?.("recovery_invalidated", record, leader);
      if (last)
        fail(
          "the recovery has fewer than two snapshot pages: its hidden staging cannot be observed",
        );
    } else {
      // Both pages at EVERY held page (C4): an intermediate follower fault is never unobserved.
      const [leader, follower] = await both();
      require(stagedProblems(leader, {
        caller,
        oldDigest,
        generation,
        rowsAtLeast: Math.max(1, rows),
      }), `at snapshot page ${record.seq}`);
      rows = leader.staging_rows;
      require(stagedProblems(follower, {
        caller,
        oldDigest,
        generation,
        rowsAtLeast: rows,
      }), `the follower at snapshot page ${record.seq}`);
      heldPages.push({ seq: record.seq, leader, follower });
      if (!stagedSeen) {
        stagedSeen = true;
        await io.observe(
          "recovery_staged_hidden",
          record.seq,
          leader.cache_digest,
          detail({ leader, follower }),
        );
        await io.onPage?.("recovery_staged_hidden", record, leader);
      }
      if (last) {
        await io.observe(
          "recovery_final_held",
          record.seq,
          leader.cache_digest,
          detail({ leader, follower, pages: heldPages }),
        );
        await io.onPage?.("recovery_final_held", record, leader);
      }
    }
    if (!last) {
      await release(
        proxyId,
        `recovery observation: snapshot page ${pages.length}`,
      );
      continue;
    }
    await release(proxyId, "recovery observation: the last snapshot page");
    // The DATA activation: every read until it commits is the staged state or the complete one, never a mixture.
    const deadline = io.now() + settleTimeoutMs;
    let final = null;
    for (;;) {
      const r = await read("leader");
      const complete = r.cache_status === "valid" && r.staging_rows === 0;
      if (complete) {
        require(activatedProblems(r, {
          oldDigest,
        }), "after the last snapshot page");
        final = r;
        break;
      }
      const staged = stagedProblems(r, {
        caller,
        oldDigest,
        generation,
        rowsAtLeast: rows,
      });
      if (staged.length > 0)
        fail(
          `a split activation: neither the staged nor the complete state (${staged.join("; ")})`,
        );
      if (io.now() > deadline)
        fail(`the activation did not commit within ${settleTimeoutMs} ms`);
      await io.sleep(25);
    }
    const follower = await read("follower");
    require(activatedProblems(follower, {
      oldDigest,
    }), "the follower after the activation");
    if (follower.cache_digest !== final.cache_digest)
      fail("the follower does not read the activated cache");
    const withRows = await read("leader", { rows: true });
    if (withRows.cache_digest !== final.cache_digest)
      fail("the cache changed between the activation and its rows");
    const verdict = expectFinal(withRows.rows ?? []);
    require(verdict, "the activated cache against the oracle");
    const { rows: content, ...leader } = withRows;
    await io.observe(
      "recovery_activated",
      record.seq,
      final.cache_digest,
      detail({
        leader,
        follower,
        rows_sha256: sha256(JSON.stringify(content ?? [])),
      }),
    );
    await io.onPage?.("recovery_activated", record, leader);
    // The RENDERED settlement (C5): both pages show the recovered cache. Until then each is hidden (ordinary rules: a displaying page behind
    // the refreshing placeholder, or the neutral state over a gated/unmounted tree) — never another state; the data stays the activated cache.
    const shownBy = io.now() + settleTimeoutMs;
    for (;;) {
      const [l, f] = await both();
      for (const r of [l, f]) {
        require(activatedProblems(r, {
          oldDigest,
        }), `the ${r.reader} before the recovered cache was shown`);
        if (r.cache_digest !== final.cache_digest)
          fail(`the ${r.reader}'s cache changed after the activation`);
      }
      const waiting = [...shownProblems(l), ...shownProblems(f)];
      if (waiting.length === 0) {
        if (caller === "recovery" && (l.fenced || f.fenced))
          fail("the recovered cache is shown while the recovery fence stands");
        await io.observe(
          "recovery_rendered",
          record.seq,
          final.cache_digest,
          detail({ leader: l, follower: f }),
        );
        await io.onPage?.("recovery_rendered", record, l);
        return { pages, final: withRows, rendered: { leader: l, follower: f } };
      }
      for (const r of [l, f])
        if (shownProblems(r).length > 0)
          require(hiddenProblems(r, {
            caller: "ordinary",
            what: "before the recovered cache is shown",
          }), "after the activation");
      if (io.now() > shownBy)
        fail(
          `the recovered cache was not shown within ${settleTimeoutMs} ms (${waiting.join("; ")})`,
        );
      await io.sleep(25);
    }
  }
}
