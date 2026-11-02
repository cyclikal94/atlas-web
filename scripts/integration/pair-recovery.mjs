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
//   5. (revision 28) `recovery_rendered`: both pages SHOW the recovered cache (see the rendering contract below). Revision 29: every sample
//      on the way, of either page, is admissible for its own fence (`admissibilityProblems`). Revision 30: every CAPTURE, including one
//      whose auth or storage bracket changed and is re-read, is first checked for what it establishes (`establishedProblems`).
// Network barriers show the state BETWEEN transactions; they cannot look inside one. Atomicity inside the W22/W23 transaction remains the
// existing native transaction controls' (qualified separately); this observer requires the evidence a split would leave between them.
import { createHash } from "node:crypto";
import { pickHeld } from "./pair-attempts.mjs";
import { AUTH_BRACKETS, STORAGE_BRACKETS } from "./pair-capture.mjs";

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
// Revision 29 (C5): /3 — every sample stated one `coherent` flag and its `incoherent_rereads`. Revision 30 (R30-DIAG; design assessment
// C1/C4): /4 — every sample carries its separate capture brackets (`capture.auth`, `capture.storage`, pair-capture.mjs), the database
// `incarnation` it read, and its permitted re-reads BY CAUSE (`rereads: {total, auth, storage}`); /2 and /3 samples are incomplete for /4,
// never upgraded.
export const OBSERVATION_SCHEMA = "web09c-recovery-observation/4";
/**
 * The most consecutive UNRESOLVED samples (a changed auth or storage bracket, nothing independently established against them) one read
 * re-reads before it fails; each is counted by cause in the sample that ends them. A count, not a clock: a hung IO call is bounded only by
 * the case's own deadline (the pair spec's test timeout), never by this.
 */
export const MAX_UNRESOLVED_REREADS = 20;
export const RECOVERY_VIEW_KINDS = Object.freeze(["displaying", "neutral"]);
const isText = (v) => typeof v === "string" && v.length > 0;

/**
 * The problems of a reader's RENDERING and its identity that hold whatever its brackets say (revision 30: checked on EVERY capture, before
 * any re-read): the rendering unavailable or malformed, no document identity, the wrong account, the reader's role not positively observed
 * (the leader page attached as leader, the follower as follower), another account displayed.
 */
export function renderingProblems(r, { account }) {
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
  return p;
}

/**
 * The problems of a sample's CAPTURE ENVELOPE (revision 30, C1): a missing or malformed bracket, an auth bracket that could not be read, a
 * stable auth bracket without a boolean fence (or a non-stable one paired with a fence), a storage bracket that could not be read again or
 * found another database incarnation, a changed storage bracket naming no field, and a sample naming no database incarnation. Failed IO is
 * a failed observation, never the `changed` alternative.
 */
export function captureProblems(r) {
  const who = r?.reader ?? "a reader";
  const c = r?.capture;
  if (!c || typeof c !== "object")
    return [`${who}'s sample states no capture brackets`];
  const p = [];
  const auth = c.auth;
  if (!AUTH_BRACKETS.includes(auth?.status))
    p.push(
      `${who}'s auth bracket is malformed (${JSON.stringify(auth?.status ?? null)})`,
    );
  else if (auth.status === "unavailable")
    p.push(
      `${who}'s auth fences are not observed (${auth.error ?? "no error stated"})`,
    );
  else if (auth.status === "stable" && typeof r.fenced !== "boolean")
    p.push(
      `${who}'s auth fences are not observed (a stable bracket, no fence)`,
    );
  else if (auth.status === "changed" && r.fenced !== null)
    p.push(`${who} pairs a changed auth bracket with a fence`);
  const storage = c.storage;
  if (!STORAGE_BRACKETS.includes(storage?.status))
    p.push(
      `${who}'s storage bracket is malformed (${JSON.stringify(storage?.status ?? null)})`,
    );
  else if (storage.status === "unavailable")
    p.push(
      `${who}'s stored state was not read again (${storage.reason ?? "no reason stated"})`,
    );
  else if (storage.status === "replaced")
    p.push(
      `${who}'s account database was replaced during the sample (${storage.reason ?? "no reason stated"})`,
    );
  else if (
    storage.status === "changed" &&
    !(Array.isArray(storage.fields) && storage.fields.length > 0)
  )
    p.push(`${who}'s changed storage bracket names no field`);
  if (!isText(r.incarnation))
    p.push(`${who}'s account database names no incarnation`);
  return p;
}

/** Whether both brackets are stable: only then is the sample's stored state associated with its rendering and fence (a usable sample). */
export const resolved = (r) =>
  r?.capture?.auth?.status === "stable" &&
  r?.capture?.storage?.status === "stable";

/**
 * The problems that make a reader's sample INCOMPLETE as a usable observation: its rendering/identity problems, its capture envelope's,
 * and either bracket not stable.
 */
export function observationProblems(r, { account }) {
  const p = [...renderingProblems(r, { account }), ...captureProblems(r)];
  if (p.length > 0) return p;
  if (!resolved(r))
    p.push(
      `${r.reader}'s sample is not resolved (auth ${r.capture.auth.status}, storage ${r.capture.storage.status})`,
    );
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

// Revision 29 (R29-DIAG, family `segmented-sync-development-pairing`, incomplete_fix of R28-DIAG.b; design assessment C1/C2, invariants
// 2-5): revision 28 published `recovery_activated` from STORED completeness alone and checked the fence only once BOTH pages were shown, so
// a page displayed while its own fence stood was accepted when it was hidden again before the settlement, or while its peer was still
// hidden. The safety condition is now PER PAGE and PER SAMPLE, checked inside the read itself (no sample reaches a caller unjudged), before
// any pair-level progress is tested:
//   - the fence implication: a sample whose auth fence stands must be the recovery-hidden shape — the neutral session over a gated or
//     unmounted protected tree. A displaying session (refreshing placeholder or not) is never that shape. It holds for either page, either
//     caller and every phase, independently of the peer.
//   - before the complete replacement: the caller's hidden rules (`hiddenProblems`), as before.
//   - after the complete replacement: each page is either HIDDEN AND WAITING (fenced: the shape above; unfenced: the ordinary hidden forms)
//     or SHOWN for the bound account with no fence. Complete data under a standing fence while hidden is LEGAL (§3.7.3/T24: the data
//     commits before the auth release); either page may show first once its own fence is clear; both shown is only the liveness end.
// A violation fails at once: a later lawful sample cannot repair an earlier forbidden one.
/** The phases a sample is judged in (`activation`: the leader's reads while the commit is awaited, judged by the stored state they hold). */
export const ADMISSIBILITY_PHASES = Object.freeze([
  "before_activation",
  "activation",
  "after_activation",
]);
/** Whether a reader holds the complete replacement in storage (the activation committed for it). */
export const holdsComplete = (r) =>
  r?.cache_status === "valid" && r?.staging_rows === 0;

/**
 * The problems of a sample's RENDERING against its own auth fence and the phase (R29-DIAG). `phase`: "before_activation" (the caller's
 * hidden rules), "after_activation" (hidden and waiting, or shown unfenced) or "activation" (whichever of the two the sample's stored state
 * is). An incomplete rendering is never admissible.
 */
export function admissibilityProblems(r, { caller, phase, what }) {
  if (!ADMISSIBILITY_PHASES.includes(phase))
    throw new Error(`unknown admissibility phase ${phase}`);
  if (!complete(r))
    return [`${r?.reader}'s rendering ${what} was not observed`];
  if (typeof r.fenced !== "boolean")
    return [`${r.reader}'s auth fences ${what} were not observed`];
  const after =
    phase === "after_activation" ||
    (phase === "activation" && holdsComplete(r));
  // After the replacement a FENCED sample has exactly one admissible shape, judged by the fence implication below; an unfenced one is
  // shown, or hidden in an ordinary form while it waits.
  let p = [];
  if (!after) p = hiddenProblems(r, { caller, what });
  else if (!r.fenced && shownProblems(r).length > 0)
    p = hiddenProblems(r, { caller: "ordinary", what });
  if (p.length > 0) return p;
  if (r.fenced) {
    const g = r.rendering;
    const surface = surfaceOf(g);
    if (g.view.kind !== "neutral" || surface !== "protected_hidden")
      return [
        `${r.reader} is ${surface === "shown" ? "shown" : `${g.view.kind} (${surface})`} while the recovery fence stands (${what})`,
      ];
  }
  return [];
}

// Revision 30 (R30-DIAG; design assessment C2, invariants 1-3): what a capture ESTABLISHES even while one of its brackets is unresolved.
// A changed auth bracket leaves the fence relation indeterminate — the fence in force at the capture was one of `true`/`false`; a changed
// storage bracket at an activation poll leaves the data phase indeterminate — the replacement was complete or it was not. The capture is
// judged under EVERY interpretation its brackets allow, and refused when no interpretation admits it: a stable fence with a displaying page
// is forbidden whatever the stored state did, and a page shown before the activation (held at the network barrier, so not yet released)
// is forbidden whatever the fence did. Only a capture some interpretation admits may be re-read. No interpretation is ever published.
/** The (fence, phase) interpretations a capture's brackets allow. */
export function interpretations(r, phase) {
  const fences =
    r?.capture?.auth?.status === "stable" ? [r.fenced] : [true, false];
  let phases = [phase];
  if (phase === "activation")
    phases =
      r?.capture?.storage?.status === "stable"
        ? [holdsComplete(r) ? "after_activation" : "before_activation"]
        : ["before_activation", "after_activation"];
  return fences.flatMap((fenced) => phases.map((p) => ({ fenced, phase: p })));
}
/**
 * The problems of a capture under every interpretation its brackets allow (none: some interpretation admits it). With both brackets stable
 * this is exactly `admissibilityProblems`.
 */
export function establishedProblems(r, { caller, phase, what }) {
  if (!ADMISSIBILITY_PHASES.includes(phase))
    throw new Error(`unknown admissibility phase ${phase}`);
  const all = interpretations(r, phase);
  const refused = [];
  for (const i of all) {
    const p = admissibilityProblems(
      { ...r, fenced: i.fenced },
      { caller, phase: i.phase, what },
    );
    if (p.length === 0) return [];
    refused.push({ ...i, p });
  }
  if (all.length === 1) return refused[0].p;
  return [
    `inadmissible under every interpretation its brackets allow (auth ${r.capture.auth.status}, storage ${r.capture.storage.status}): ${refused
      .map(
        (x) =>
          `[fenced ${x.fenced}, ${x.phase.replace("_", " ")}] ${x.p.join("; ")}`,
      )
      .join(" | ")}`,
  ];
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
 * Revision 29 (R29-DIAG): EVERY read — each held page, each activation poll, the complete follower, the row-bearing leader read and every
 * settlement poll — is judged by `admissibilityProblems` for that page against its own fence before it is used, irrespective of its peer.
 * Revision 30 (R30-DIAG): each read's samples carry separate capture brackets (pair-capture.mjs); independently established failures are
 * refused on the capture that establishes them, before any re-read of an unresolved bracket. `io.failed?({reason, capture})` receives the
 * first failure's facts before the throw (the owner keeps them in the incomplete interval).
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
  const fail = (what, capture = null) => {
    const error = new Error(`recovery observation: ${what}`);
    // Revision 30 (C3): the failing capture's own facts travel with the failure (and are recorded by the owner's `failed` hook BEFORE the
    // throw, so the incomplete interval keeps them); no later read is needed to confirm it, and no milestone follows it.
    if (capture) error.capture = capture;
    try {
      io.failed?.({ reason: error.message, capture });
    } catch {
      // The failure itself stands whatever its recording does.
    }
    throw error;
  };
  const require = (problems, what, capture = null) => {
    if (problems.length > 0) fail(`${what}: ${problems.join("; ")}`, capture);
  };
  const documents = {};
  let incarnation;
  /** What a failed capture reports: page, phase, read number, both brackets, its document and database identity, its stamp. */
  const factsOf = (who, phase, n, r, rereads) => ({
    reader: who,
    page: r?.page ?? null,
    phase,
    read: n,
    rereads: { ...rereads },
    capture: r?.capture ?? null,
    fenced: r?.fenced ?? null,
    document: r?.rendering?.status === "observed" ? r.rendering.document : null,
    rendering_status: r?.rendering?.status ?? null,
    incarnation: r?.incarnation ?? null,
    stored: r
      ? {
          cache_status: r.cache_status ?? null,
          staging_rows: r.staging_rows ?? null,
          recovery_generation: r.recovery_generation ?? null,
          composition_seq: r.composition_seq ?? null,
          cache_digest: r.cache_digest ?? null,
        }
      : null,
  });
  // Revision 30 (R30-DIAG; design assessment C2): every capture of a read — including each one later re-read — is checked IN THIS ORDER:
  //   1. the IO (a read that throws fails), the reader's role, the capture envelope (malformed/missing brackets, unreadable fences, a
  //      storage read that failed, found no database or another incarnation), the rendering and its identity (observed, complete, the
  //      account, the positive attachment, the same document as before, not the peer's document, the same database incarnation);
  //   2. what the capture ESTABLISHES under every interpretation its brackets allow (`establishedProblems`): the fence implication when the
  //      auth bracket is stable, the hidden rules when the phase is fixed by the held barrier, both phase readings of an activation poll
  //      whose storage moved;
  //   3. only then, a capture with a changed bracket is re-read — bounded (MAX_UNRESOLVED_REREADS consecutive) and counted by cause;
  //   4. a resolved capture (both brackets stable) is judged in full (`admissibilityProblems`, the same as 2 with one interpretation) and
  //      returned with its counts.
  // Revision 29 re-read on one merged `coherent: false` BEFORE any check, so a storage-only change discarded a stable fenced exposure or
  // an unavailable rendering and a later lawful sample succeeded.
  const read = async (who, phase, opts) => {
    if (!ADMISSIBILITY_PHASES.includes(phase))
      throw new Error(`a read of the ${who} names no admissibility phase`);
    const what = `at ${phase.replace("_", " ")}`;
    const rereads = { total: 0, auth: 0, storage: 0 };
    for (let n = 1; ; n += 1) {
      let r;
      try {
        r = await io.read(who, opts);
      } catch (error) {
        fail(
          `the ${who}'s read failed: ${String(error?.message ?? error)}`,
          factsOf(who, phase, n, null, rereads),
        );
      }
      const facts = () => factsOf(who, phase, n, r, rereads);
      if (r?.reader !== who)
        fail(`a read of the ${who} returned ${r?.reader}`, facts());
      require([
        ...captureProblems(r),
        ...renderingProblems(r, { account }),
      ], `an incomplete observation of the ${who} (${what}, read ${n})`, facts());
      const doc = r.rendering.document;
      if (documents[who] === undefined) documents[who] = doc;
      else if (documents[who] !== doc)
        fail(
          `the ${who}'s document changed during the observation (reloaded or replaced)`,
          facts(),
        );
      const other = documents[who === "leader" ? "follower" : "leader"];
      if (other !== undefined && other === doc)
        fail("the follower is the leading page's own document", facts());
      if (incarnation === undefined) incarnation = r.incarnation;
      else if (incarnation !== r.incarnation)
        fail(
          `the ${who} reads another account database incarnation (${r.incarnation}, not ${incarnation}): replaced during the observation`,
          facts(),
        );
      require(establishedProblems(r, {
        caller,
        phase,
        what,
      }), `the ${who}'s page is not admissible`, facts());
      if (resolved(r)) {
        r.rereads = { ...rereads };
        return r;
      }
      rereads.total += 1;
      if (r.capture.auth.status === "changed") rereads.auth += 1;
      if (r.capture.storage.status === "changed") rereads.storage += 1;
      if (rereads.total > MAX_UNRESOLVED_REREADS)
        fail(
          `no resolved sample of the ${who} in ${rereads.total} reads ${what} (auth ${r.capture.auth.status}${r.capture.auth.reason ? `: ${r.capture.auth.reason}` : ""}; storage ${r.capture.storage.status}${r.capture.storage.fields ? `: ${r.capture.storage.fields.join(", ")}` : ""})`,
          facts(),
        );
    }
  };
  const both = async (phase, opts) => [
    await read("leader", phase, opts),
    await read("follower", phase, opts),
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
      const [leader, follower] = await both("before_activation");
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
      const [leader, follower] = await both("before_activation");
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
      // Each poll is judged for what the page shows against its own fence (R29-DIAG): complete data while fenced must stay hidden.
      const r = await read("leader", "activation");
      if (holdsComplete(r)) {
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
    const follower = await read("follower", "after_activation");
    require(activatedProblems(follower, {
      oldDigest,
    }), "the follower after the activation");
    if (follower.cache_digest !== final.cache_digest)
      fail("the follower does not read the activated cache");
    // The row-bearing read is the sample `recovery_activated` publishes: it is judged in full itself (R29-DIAG, invariant 6).
    const withRows = await read("leader", "after_activation", { rows: true });
    require(activatedProblems(withRows, {
      oldDigest,
    }), "the leader's row-bearing read after the activation");
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
    // The RENDERED settlement (C5): both pages show the recovered cache. Until then each page is judged ON ITS OWN in the read (R29-DIAG):
    // hidden and waiting (fenced: the neutral state over a gated/unmounted tree; unfenced: also a displaying page behind the refreshing
    // placeholder) or shown with its fence clear — never shown while fenced, whatever its peer shows; the data stays the activated cache.
    const shownBy = io.now() + settleTimeoutMs;
    for (;;) {
      const [l, f] = await both("after_activation");
      for (const r of [l, f]) {
        require(activatedProblems(r, {
          oldDigest,
        }), `the ${r.reader} before the recovered cache was shown`);
        if (r.cache_digest !== final.cache_digest)
          fail(`the ${r.reader}'s cache changed after the activation`);
      }
      const waiting = [...shownProblems(l), ...shownProblems(f)];
      if (waiting.length === 0) {
        // Already refused per page in the read; kept as the explicit end condition (both shown, neither fenced, either caller).
        if (l.fenced || f.fenced)
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
      if (io.now() > shownBy)
        fail(
          `the recovered cache was not shown within ${settleTimeoutMs} ms (${waiting.join("; ")})`,
        );
      await io.sleep(25);
    }
  }
}
