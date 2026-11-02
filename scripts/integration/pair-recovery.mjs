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
//   Revision 31 (R31-DIAG): every stored predicate a coherent transaction can decide on its own — with the barrier's immutable read context
//      — is judged on BOTH stored transactions of every capture (the first read and the bracket's second read), before any re-read
//      (`storedProblemsAt`). Only the association of the rendering with the data still needs a stable bracket.
// Network barriers show the state BETWEEN transactions; they cannot look inside one. Atomicity inside the W22/W23 transaction remains the
// existing native transaction controls' (qualified separately); this observer requires the evidence a split would leave between them.
import { createHash } from "node:crypto";
import { pickHeld } from "./pair-attempts.mjs";
import {
  AUTH_BRACKETS,
  ENDPOINT_FIELDS,
  STAMP_FIELDS,
  STORAGE_BRACKETS,
} from "./pair-capture.mjs";

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
// never upgraded. Revision 31 (R31-DIAG; design assessment C3/C6): /5 — every recorded sample also carries its SECOND coherent stored
// transaction (`stored_after`, pair-capture.mjs `ENDPOINT_FIELDS`), of the same incarnation and, its storage bracket being stable, equal to
// the first on every stamp field; the live observer judged both endpoints' data before recording it. /4 records were made by an observer
// that judged only the first endpoint, and only on a resolved capture: incomplete for /5, never upgraded.
export const OBSERVATION_SCHEMA = "web09c-recovery-observation/5";
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
  else p.push(...endpointProblems(r));
  if (!isText(r.incarnation))
    p.push(`${who}'s account database names no incarnation`);
  return p;
}

/**
 * Revision 31 (R31-DIAG; C3, DA31-ENDPOINT): the SECOND stored transaction a stable or changed storage bracket was made from must be retained
 * (`stored_after`), of the sample's own database incarnation, and agree with the bracket: a stable bracket equal to the first transaction
 * on every stamp field, a changed one naming exactly the fields that differ.
 */
function endpointProblems(r) {
  const who = r?.reader ?? "a reader";
  const a = r?.stored_after;
  if (!a || typeof a !== "object")
    return [`${who}'s second stored read is not retained`];
  if (a.incarnation !== r.incarnation)
    return [
      `${who}'s second stored read names another incarnation (${a.incarnation ?? "none"})`,
    ];
  const moved = STAMP_FIELDS.filter(
    (k) => JSON.stringify(r[k] ?? null) !== JSON.stringify(a[k] ?? null),
  );
  const named =
    r.capture.storage.status === "stable" ? [] : r.capture.storage.fields;
  return JSON.stringify(moved) === JSON.stringify(named)
    ? []
    : [
        `${who}'s ${r.capture.storage.status} storage bracket disagrees with its second read (differing: ${moved.join(", ") || "none"})`,
      ];
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
  if (phase === "activation") {
    // Revision 31 (C2): the data phase of each coherent transaction is KNOWN (each is judged staged or complete on its own before this); the
    // rendering, captured between the two, is uncertain only when they differ. Without a retained second read the phase is open.
    const stable = r?.capture?.storage?.status === "stable";
    const ends = stable ? [r] : r?.stored_after ? [r, r.stored_after] : null;
    phases =
      ends === null
        ? ["before_activation", "after_activation"]
        : [
            ...new Set(
              ends.map((e) =>
                holdsComplete(e) ? "after_activation" : "before_activation",
              ),
            ),
          ];
  }
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

// Revision 31 (R31-DIAG, family `segmented-sync-development-pairing`, incomplete_fix of R30-DIAG; design assessment C1/C2): the STORED-DATA
// predicates are separated from the rendering/notice/auth ones. Each takes ONE coherent stored transaction `s` (a sample's first read, or
// its `stored_after`) and the barrier's immutable expectations, and nothing a page shows: a coherent transaction's own relationships stand
// whatever happened to the rendering, the auth fences or an unrelated composition write around it. Revision 30 judged them only on a
// RESOLVED capture after `read()` returned, so a changed bracket discarded an already invalid transaction and a later healthy sample passed.
// `who` names the reader (an endpoint carries no reader of its own).
/** The barriers a read is made at (its read context's `barrier`), each with its stored predicate. */
export const STORED_BARRIERS = Object.freeze([
  "invalidated",
  "staged",
  "activation",
  "activated",
]);

/** The STORED invalidation (`recovery_invalidated`): `generation` (the follower's context) is the leader's validated generation. */
export function storedInvalidatedProblems(
  s,
  { who, caller, oldDigest, refusalGeneration, generation = null },
) {
  const p = [];
  if (s.cache_status === "valid") p.push(`${who} still shows a valid cache`);
  if (s.cursor !== null) p.push(`${who} keeps a cursor`);
  if (s.delta_stage !== null || s.staged !== 0)
    p.push(`${who} keeps the abandoned delta stage`);
  if (s.staging_rows !== 0)
    p.push(`${who} holds snapshot rows before the first page`);
  if (!(s.recovery_generation > refusalGeneration))
    p.push(`${who} has no new recovery generation`);
  if (generation !== null && s.recovery_generation !== generation)
    p.push(
      `${who} does not read the leader's generation ${generation} (${s.recovery_generation})`,
    );
  if (s.cache_digest !== oldDigest)
    p.push(`${who}'s live cache changed before the snapshot`);
  if (caller === "recovery" && who === "leader" && s.phase !== "snapshot")
    p.push("the recovery caller's refusal did not restart the snapshot");
  return p;
}
/** What the pages show and the auth/notice facts at the invalidation (judged on a resolved capture: they need its stable brackets). */
export function invalidatedRenderingProblems(r, { caller }) {
  const p = hiddenProblems(r, { caller, what: "while the cache is invalid" });
  if (r.reader === "leader") {
    if (caller === "recovery") {
      if (r.notice?.reason !== "resync_required")
        p.push("the recovery job did not record its server restart");
      if (r.fenced !== true) p.push("the recovery caller is no longer fenced");
    } else if (r.fenced === true) p.push("an ordinary caller is fenced");
  }
  return p;
}
/** The problems of a reader's state right after the refusal was processed (`recovery_invalidated`): stored and rendered. */
export function invalidatedProblems(r, o) {
  return [
    ...storedInvalidatedProblems(r, { ...o, who: r.reader }),
    ...invalidatedRenderingProblems(r, o),
  ];
}

/** The STORED staging at a held page: `rowsAtLeast` the validated row floor, `generation` the bound recovery generation. */
export function storedStagedProblems(
  s,
  { who, oldDigest, generation, rowsAtLeast = 1 },
) {
  const p = [];
  if (!(Number.isInteger(s.staging_rows) && s.staging_rows >= rowsAtLeast))
    p.push(
      `${who} holds ${s.staging_rows} staged rows, expected at least ${rowsAtLeast}`,
    );
  if (
    !(
      s.staging_generations?.length === 1 &&
      s.staging_generations[0] === generation
    )
  )
    p.push(`${who}'s staged rows are not all of generation ${generation}`);
  if (s.recovery_generation !== generation)
    p.push(`${who} moved to generation ${s.recovery_generation}`);
  if (s.cache_digest !== oldDigest)
    p.push(`${who}'s live cache changed before the activation`);
  if (s.cache_status === "valid")
    p.push(`${who} shows a valid cache before the last page`);
  return p;
}
/** What the pages show and the fence while the snapshot is staged (judged on a resolved capture). */
export function stagedRenderingProblems(r, { caller }) {
  const p = hiddenProblems(r, { caller, what: "while the snapshot is staged" });
  if (caller === "recovery" && r.reader === "leader" && r.fenced !== true)
    p.push("the fence was cleared before the snapshot was complete");
  return p;
}
/** The problems of a reader's state while the snapshot is staged (`recovery_staged_hidden`, `recovery_final_held`, every later page). */
export function stagedProblems(r, o) {
  return [
    ...storedStagedProblems(r, { ...o, who: r.reader }),
    ...stagedRenderingProblems(r, o),
  ];
}

/**
 * The complete STORED state after the activation. `digest` (once the activation was validated): the activated cache every later
 * transaction must still hold; `mismatch` names that failure at its site.
 */
export function storedActivatedProblems(
  s,
  { who, oldDigest, digest = null, mismatch = null },
) {
  const p = [];
  if (s.cache_status !== "valid") p.push(`${who} does not hold a valid cache`);
  if (s.staging_rows !== 0 || s.delta_stage !== null || s.staged !== 0)
    p.push(`${who} still holds staged rows after the activation`);
  if (s.cache_digest === oldDigest) p.push(`${who} still holds the old cache`);
  if (digest !== null && s.cache_digest !== digest)
    p.push(
      mismatch ??
        `${who} does not hold the activated cache ${digest} (${s.cache_digest})`,
    );
  return p;
}
/** The complete STORED state after the activation (data only: what the page shows is `shownProblems`'s, recorded separately). */
export function activatedProblems(r, { oldDigest }) {
  return storedActivatedProblems(r, { who: r.reader, oldDigest });
}

/**
 * One coherent transaction polled while the activation commits: wholly the staged state or wholly the complete one — never a mixture (a
 * valid cache with rows still staged, a changed cache before validity). `witness`: the digest of a complete transaction already validated
 * at this activation; every later transaction must then be complete with that very cache (the activation never goes backwards).
 */
export function activationProblems(
  s,
  { who, oldDigest, generation, rowsAtLeast, witness = null },
) {
  const complete = storedActivatedProblems(s, {
    who,
    oldDigest,
    digest: witness,
  });
  if (witness !== null)
    return complete.length === 0
      ? []
      : [
          `the activation went backwards: a complete cache ${witness} was read, then ${complete.join("; ")}`,
        ];
  if (complete.length === 0) return [];
  const staged = storedStagedProblems(s, {
    who,
    oldDigest,
    generation,
    rowsAtLeast,
  });
  return staged.length === 0
    ? []
    : [
        `a split activation: neither the staged nor the complete state (staged: ${staged.join("; ")} | complete: ${complete.join("; ")})`,
      ];
}

/**
 * The stored problems of ONE coherent transaction `s` of the `who` reader at the read context `ctx` (its `barrier` and expectations) —
 * everything the transaction decides on its own. `rowsAtLeast` (the staged barrier) may be raised within a capture by its validated first
 * transaction; `witness` (the activation) is the validated complete digest so far.
 */
export function storedProblemsAt(s, ctx, { who, rowsAtLeast, witness }) {
  switch (ctx.barrier) {
    case "invalidated":
      return storedInvalidatedProblems(s, { ...ctx, who });
    case "staged":
      return storedStagedProblems(s, { ...ctx, who, rowsAtLeast });
    case "activation":
      return activationProblems(s, { ...ctx, who, witness });
    case "activated":
      return storedActivatedProblems(s, { ...ctx, who });
    default:
      throw new Error(`unknown stored barrier ${ctx.barrier}`);
  }
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
  const fail = (what, facts = null) => {
    const error = new Error(`recovery observation: ${what}`);
    // Revision 30 (C3): the failing capture's own facts travel with the failure (and are recorded by the owner's `failed` hook BEFORE the
    // throw, so the incomplete interval keeps them); no later read is needed to confirm it, and no milestone follows it. Revision 31 (C5):
    // EVERY failure carries facts — the stored, pairwise, oracle and rendering ones as well as the capture envelope's.
    if (facts) error.capture = facts;
    try {
      io.failed?.({ reason: error.message, capture: facts });
    } catch {
      // The failure itself stands whatever its recording does.
    }
    throw error;
  };
  const require = (problems, what, facts = null) => {
    if (problems.length > 0) fail(`${what}: ${problems.join("; ")}`, facts);
  };
  const documents = {};
  let incarnation;
  /** A coherent stored transaction's fields as a failure reports them (every stored input of the predicates; never rows or local work). */
  const endpointOf = (e) =>
    e
      ? Object.fromEntries(ENDPOINT_FIELDS.map((k) => [k, e[k] ?? null]))
      : null;
  /** The read context's expectations as a failure reports them (never the live witness object itself). */
  const expectedOf = (ctx, extra) =>
    ctx
      ? Object.fromEntries(
          Object.entries({ ...ctx, ...extra }).filter(
            ([k]) => k !== "label" && k !== "mismatch",
          ),
        )
      : null;
  /**
   * What a failure reports (revision 31, C5): the reader and its page, the barrier and held answer of the read context, the admissibility
   * phase, the read number and its re-reads, the failing predicate and endpoint, the context's expectations, both brackets, the fence and
   * notice, document and database identity, BOTH coherent stored endpoints and, when rows were judged, their count, hash and problems.
   */
  const factsOf = (who, ctx, n, r, rereads, extra = {}) => ({
    reader: who,
    page: r?.page ?? null,
    barrier: ctx?.barrier ?? null,
    held_seq: ctx?.seq ?? null,
    phase: ctx?.phase ?? null,
    read: n,
    rereads: rereads ? { ...rereads } : null,
    predicate: extra.predicate ?? null,
    endpoint: extra.endpoint ?? null,
    expected: expectedOf(ctx, extra.expected),
    capture: r?.capture ?? null,
    fenced: r?.fenced ?? null,
    notice: r?.notice ?? null,
    document: r?.rendering?.status === "observed" ? r.rendering.document : null,
    rendering_status: r?.rendering?.status ?? null,
    incarnation: r?.incarnation ?? null,
    stored: endpointOf(r),
    stored_after: r?.stored_after ? endpointOf(r.stored_after) : null,
    rows: extra.rows ?? null,
  });
  /** The facts of a failure made of a RESOLVED sample after its read (its number and re-reads as the read returned them). */
  const factsOfSample = (r, ctx, predicate) =>
    factsOf(r.reader, ctx, r.read ?? null, r, r.rereads, { predicate });
  /** The facts of a failure at a barrier that no single capture makes (the held answers, their release, the pages). */
  const barrierFacts = (extra) => ({ barrier: "held", ...extra });
  // Revision 31 (R31-DIAG, C4): the digest of the first COMPLETE stored transaction validated at the activation (null before). Set only
  // from a validated endpoint, never from an unchecked capture; every later transaction must hold that very cache.
  let witness = null;
  // Revision 30 (R30-DIAG; design assessment C2) and revision 31 (R31-DIAG; C1/C2): every capture of a read — including each one later
  // re-read — is checked IN THIS ORDER, all before any re-read:
  //   1. the IO (a read that throws fails), the reader's role, the capture envelope (malformed/missing brackets, unreadable fences, a
  //      storage read that failed, found no database or another incarnation, a second stored read not retained or disagreeing with its
  //      bracket), the rendering and its identity (observed, complete, the account, the positive attachment, the same document as before,
  //      not the peer's document, the same database incarnation);
  //   2. (revision 31) BOTH coherent stored transactions — the first read, then the bracket's second — against the read context `ctx` (its
  //      barrier and frozen expectations: `storedProblemsAt`), the generation standing within a held invalidation, and, at the row-bearing
  //      read, the requested rows present and the caller's oracle on them: what the data establishes needs no stable bracket;
  //   3. what the capture's RENDERING establishes under every interpretation its brackets allow (`establishedProblems`);
  //   4. only then, a capture with a changed bracket is re-read — bounded (MAX_UNRESOLVED_REREADS consecutive) and counted by cause;
  //   5. a resolved capture (both brackets stable) is returned with its counts.
  // `ctx` is built by the caller BEFORE the read from validated samples only and frozen: {barrier, seq, label, …expectations}.
  const read = async (who, phase, ctx, opts) => {
    if (!ADMISSIBILITY_PHASES.includes(phase))
      throw new Error(`a read of the ${who} names no admissibility phase`);
    if (!STORED_BARRIERS.includes(ctx?.barrier))
      throw new Error(`a read of the ${who} names no stored barrier`);
    const at = Object.freeze({ ...ctx, phase });
    const what = `at ${phase.replace("_", " ")}`;
    const rereads = { total: 0, auth: 0, storage: 0 };
    for (let n = 1; ; n += 1) {
      let r;
      try {
        r = await io.read(who, opts);
      } catch (error) {
        fail(
          `the ${who}'s read failed: ${String(error?.message ?? error)}`,
          factsOf(who, at, n, null, rereads, { predicate: "io" }),
        );
      }
      const facts = (predicate, extra = {}) =>
        factsOf(who, at, n, r, rereads, { predicate, ...extra });
      if (r?.reader !== who)
        fail(`a read of the ${who} returned ${r?.reader}`, facts("role"));
      require([
        ...captureProblems(r),
        ...renderingProblems(r, { account }),
      ], `an incomplete observation of the ${who} (${what}, read ${n})`, facts(
        "envelope",
      ));
      const doc = r.rendering.document;
      if (documents[who] === undefined) documents[who] = doc;
      else if (documents[who] !== doc)
        fail(
          `the ${who}'s document changed during the observation (reloaded or replaced)`,
          facts("identity.document"),
        );
      const other = documents[who === "leader" ? "follower" : "leader"];
      if (other !== undefined && other === doc)
        fail(
          "the follower is the leading page's own document",
          facts("identity.peer"),
        );
      if (incarnation === undefined) incarnation = r.incarnation;
      else if (incarnation !== r.incarnation)
        fail(
          `the ${who} reads another account database incarnation (${r.incarnation}, not ${incarnation}): replaced during the observation`,
          facts("identity.incarnation"),
        );
      // 2. Both coherent stored transactions, each on its own (revision 31).
      let rowsAtLeast = at.rowsAtLeast;
      for (const [endpoint, e] of [
        ["first", r],
        ["second", r.stored_after],
      ]) {
        const problems = storedProblemsAt(e, at, { who, rowsAtLeast, witness });
        if (problems.length > 0)
          fail(
            `${at.label}: ${problems.join("; ")} [the ${endpoint} stored read of capture ${n}]`,
            facts(`stored.${at.barrier}`, {
              endpoint,
              expected: { rowsAtLeast, witness },
            }),
          );
        if (at.barrier === "staged")
          rowsAtLeast = Math.max(rowsAtLeast, e.staging_rows);
        if (at.barrier === "activation" && witness === null && holdsComplete(e))
          witness = e.cache_digest;
      }
      if (
        at.barrier === "invalidated" &&
        r.stored_after.recovery_generation !== r.recovery_generation
      )
        fail(
          `${at.label}: the ${who}'s recovery generation moved during a held capture (${r.recovery_generation}, then ${r.stored_after.recovery_generation})`,
          facts("stored.generation_moved"),
        );
      if (opts?.rows) {
        if (!Array.isArray(r.rows))
          fail(
            `${at.label}: the requested rows were not read (capture ${n})`,
            facts("rows.missing"),
          );
        const verdict = expectFinal(r.rows);
        if (verdict.length > 0)
          fail(
            `the activated cache against the oracle: ${verdict.join("; ")} (capture ${n})`,
            facts("rows.oracle", {
              rows: {
                count: r.rows.length,
                sha256: sha256(JSON.stringify(r.rows)),
                problems: verdict.slice(0, 20),
              },
            }),
          );
      }
      // 3. What the rendering establishes.
      require(establishedProblems(r, {
        caller,
        phase,
        what,
      }), `the ${who}'s page is not admissible`, facts("rendering.admissible"));
      if (resolved(r)) {
        r.read = n;
        r.rereads = { ...rereads };
        return r;
      }
      rereads.total += 1;
      if (r.capture.auth.status === "changed") rereads.auth += 1;
      if (r.capture.storage.status === "changed") rereads.storage += 1;
      if (rereads.total > MAX_UNRESOLVED_REREADS)
        fail(
          `no resolved sample of the ${who} in ${rereads.total} reads ${what} (auth ${r.capture.auth.status}${r.capture.auth.reason ? `: ${r.capture.auth.reason}` : ""}; storage ${r.capture.storage.status}${r.capture.storage.fields ? `: ${r.capture.storage.fields.join(", ")}` : ""})`,
          facts("rereads.bound"),
        );
    }
  };
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
          barrierFacts({ predicate: "held.timeout", pages: [...pages] }),
        );
      await io.sleep(25);
    }
  };
  const release = async (proxyId, reason) => {
    handled.add(proxyId);
    const released = await io.release(ruleId, proxyId);
    if (released.released !== 1)
      fail(
        `releasing proxy entry ${proxyId} released ${released.released}`,
        barrierFacts({ predicate: "held.release", proxy_id: proxyId }),
      );
    const outcome = released.outcomes?.[0]?.outcome ?? null;
    await io.recordRelease({ proxy_id: proxyId, outcome, reason });
    if (outcome !== "delivered")
      fail(
        `the snapshot answer ${proxyId} was ${outcome}, not delivered`,
        barrierFacts({
          predicate: "held.delivery",
          proxy_id: proxyId,
          outcome,
        }),
      );
  };
  const detail = (extra) => ({ schema: OBSERVATION_SCHEMA, ...extra });
  for (;;) {
    const { record, proxyId } = await nextHeld();
    if (!(record.status === 200 && record.phase === "snapshot"))
      fail(
        `answer ${record.seq} held during the recovery is ${record.status} ${record.phase}, not a snapshot page`,
        barrierFacts({ predicate: "held.snapshot", held_seq: record.seq }),
      );
    pages.push(record.seq);
    if (pages.length > maxPages)
      fail(
        `more than ${maxPages} snapshot pages`,
        barrierFacts({ predicate: "held.pages", held_seq: record.seq }),
      );
    const last = record.has_more === false;
    if (pages.length === 1) {
      // The leader binds the generation (from its validated sample); the follower's context then requires it.
      const first = {
        barrier: "invalidated",
        seq: record.seq,
        label: `at the first snapshot page ${record.seq}`,
        caller,
        oldDigest,
        refusalGeneration: refusal.generation,
        generation: null,
      };
      const leader = await read("leader", "before_activation", first);
      const follower = await read("follower", "before_activation", {
        ...first,
        generation: leader.recovery_generation,
      });
      for (const r of [leader, follower])
        require(invalidatedRenderingProblems(r, {
          caller,
        }), `at the first snapshot page ${record.seq}`, factsOfSample(
          r,
          first,
          "rendering.invalidated",
        ));
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
          barrierFacts({ predicate: "held.pages", held_seq: record.seq }),
        );
    } else {
      // Both pages at EVERY held page (C4): an intermediate follower fault is never unobserved. The row floor comes from the last
      // validated leader sample (rows never go backwards); the follower's from the leader's at this page.
      const staged = {
        barrier: "staged",
        seq: record.seq,
        label: `at snapshot page ${record.seq}`,
        oldDigest,
        generation,
        rowsAtLeast: Math.max(1, rows),
      };
      const leader = await read("leader", "before_activation", staged);
      const follower = await read("follower", "before_activation", {
        ...staged,
        label: `the follower at snapshot page ${record.seq}`,
        rowsAtLeast: leader.staging_rows,
      });
      for (const r of [leader, follower])
        require(stagedRenderingProblems(r, { caller }), r === leader
          ? `at snapshot page ${record.seq}`
          : `the follower at snapshot page ${record.seq}`, factsOfSample(
          r,
          staged,
          "rendering.staged",
        ));
      rows = leader.staging_rows;
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
    // The DATA activation: every coherent transaction read until it commits is the staged state or the complete one, never a mixture,
    // and never staged again once a complete one was validated (judged in the read, on both endpoints of every capture).
    const activation = {
      barrier: "activation",
      seq: record.seq,
      label: "after the last snapshot page",
      oldDigest,
      generation,
      rowsAtLeast: rows,
    };
    const deadline = io.now() + settleTimeoutMs;
    let final = null;
    for (;;) {
      // Each poll is judged for what the page shows against its own fence (R29-DIAG): complete data while fenced must stay hidden.
      const r = await read("leader", "activation", activation);
      if (holdsComplete(r)) {
        final = r;
        break;
      }
      if (io.now() > deadline)
        fail(
          `the activation did not commit within ${settleTimeoutMs} ms`,
          factsOfSample(r, activation, "activation.timeout"),
        );
      await io.sleep(25);
    }
    const activated = {
      barrier: "activated",
      seq: record.seq,
      oldDigest,
      digest: final.cache_digest,
    };
    const follower = await read("follower", "after_activation", {
      ...activated,
      label: "the follower after the activation",
      mismatch: "the follower does not read the activated cache",
    });
    // The row-bearing read is the sample `recovery_activated` publishes: its rows are judged by the oracle on EVERY capture of it, before
    // any re-read (R29-DIAG invariant 6; revision 31 C4) — a later valid row read never repairs an earlier failing one.
    const withRows = await read(
      "leader",
      "after_activation",
      {
        ...activated,
        label: "the leader's row-bearing read after the activation",
        mismatch: "the cache changed between the activation and its rows",
      },
      { rows: true },
    );
    const { rows: content, ...leader } = withRows;
    await io.observe(
      "recovery_activated",
      record.seq,
      final.cache_digest,
      detail({
        leader,
        follower,
        rows_sha256: sha256(JSON.stringify(content)),
      }),
    );
    await io.onPage?.("recovery_activated", record, leader);
    // The RENDERED settlement (C5): both pages show the recovered cache. Until then each page is judged ON ITS OWN in the read (R29-DIAG):
    // hidden and waiting (fenced: the neutral state over a gated/unmounted tree; unfenced: also a displaying page behind the refreshing
    // placeholder) or shown with its fence clear — never shown while fenced, whatever its peer shows; the data stays the activated cache
    // in every coherent transaction of every capture (revision 31: judged in the read, before any re-read).
    const settling = (who) => ({
      ...activated,
      label: `the ${who} before the recovered cache was shown`,
      mismatch: `the ${who}'s cache changed after the activation`,
    });
    const shownBy = io.now() + settleTimeoutMs;
    for (;;) {
      const l = await read("leader", "after_activation", settling("leader"));
      const f = await read(
        "follower",
        "after_activation",
        settling("follower"),
      );
      const waiting = [...shownProblems(l), ...shownProblems(f)];
      if (waiting.length === 0) {
        // Already refused per page in the read; kept as the explicit end condition (both shown, neither fenced, either caller).
        if (l.fenced || f.fenced)
          fail(
            "the recovered cache is shown while the recovery fence stands",
            factsOfSample(l.fenced ? l : f, activated, "settlement.fenced"),
          );
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
          factsOfSample(f, activated, "settlement.timeout"),
        );
      await io.sleep(25);
    }
  }
}
