// WEB-09c revision 30 (R30-DIAG, family `segmented-sync-development-pairing`, incomplete_fix of R29-DIAG with a regression subcase; design
// assessment C1/C5): the CAPTURE CONTRACT of one recovery sample, kept apart from the browser and the pair runner (no state, bridge or
// evidence at import) so the maintained composition itself — the in-page capture, the page wrapper and the storage bracket around it — is
// driven by deterministic tests (pair-capture.test.mjs, pair-recovery.test.mjs) and used unchanged by the pair spec (tests/pair/support.ts
// `recoveryReader`, tests/pair/rendering.ts `renderingOf`).
//
// Revision 29 folded three facts into one `coherent` flag: the rendering's availability, whether the account's auth fences stood still
// across the capture, and whether the stored state stood still across it. `recoveryReader` then wrote `coherent: seen.coherent &&
// unchanged`, so a storage-only change (e.g. `composition_seq` advanced by a draft or pending-effect write in another tab) turned a capture
// whose fence was STABLE and whose page DISPLAYED, or a capture whose rendering was UNAVAILABLE, into "incoherent"; the observer re-read it
// before any check and a later lawful sample succeeded. Now the three facts are separate and never overwrite each other:
//
//   rendering        {status: "observed", …} | {status: "unavailable", error}   (what the page shows; unavailable is a failed observation)
//   capture.auth     {status: "stable"} (the top-level `fenced` boolean was in force throughout the capture)
//                    | {status: "changed", reason} (`fenced` null: the fence relation is indeterminate, never paired with the later DOM)
//                    | {status: "unavailable", error} (`fenced` null: the fences could not be read — a failed observation, not a change)
//   capture.storage  {status: "stable"} | {status: "changed", fields, before, after} (the stamp fields that moved, both endpoints)
//                    | {status: "replaced", reason, incarnation_after} (another database incarnation: identity lost, a failure)
//                    | {status: "unavailable", reason} (the second read failed or found no database: a failed observation)
//
// A bracket DETECTS some uncertainty between two reads; it neither serialises the product's writers nor proves that every transient state
// was observed (an A→B→A change inside one bracket is invisible to it).

/** The auth bracket's outcomes and the storage bracket's. Anything else is a malformed capture (incomplete). */
export const AUTH_BRACKETS = Object.freeze([
  "stable",
  "changed",
  "unavailable",
]);
export const STORAGE_BRACKETS = Object.freeze([
  "stable",
  "changed",
  "replaced",
  "unavailable",
]);
/**
 * The stored fields a sample is judged on, compared between the two storage reads (`composition_seq` advances with every cache, draft,
 * draft-command and pending-effect write, model/composition.ts). The database's `incarnation` is compared separately: a different one is
 * a replaced database, never a "change" of this one.
 */
export const STAMP_FIELDS = Object.freeze([
  "composition_seq",
  "cache_status",
  "cache_digest",
  "applied_revision",
  "cursor",
  "phase",
  "delta_stage",
  "staged",
  "recovery_generation",
  "staging_rows",
  "staging_generations",
]);

const message = (error) =>
  String(error?.message ?? error ?? "unknown error").slice(0, 300);
const pick = (s, fields) =>
  Object.fromEntries(fields.map((k) => [k, s?.[k] ?? null]));

/**
 * The page side of one capture: SELF-CONTAINED (it is serialised into the page by `page.evaluate`, so it references nothing outside its
 * own body; deterministic tests run it against doubled `window`/`document` globals). The account's fence entries are read BEFORE and
 * AFTER one synchronous turn that captures everything the page shows — the session view, the data attachment and the leader's notice,
 * #protected-root (gated = inert AND aria-hidden="true"; mounted = it has children), the cache gate's placeholders and those actually
 * VISIBLE — and a per-document identity (minted once per document: a reload or a replaced page is another document). The rendering's
 * availability and the auth bracket are independent outcomes: an unreadable session view leaves the fence reads standing, and an
 * unreadable fence leaves the rendering standing.
 */
export async function captureInPage(who) {
  const text = (error) =>
    String(error?.message ?? error ?? "unknown error").slice(0, 300);
  const w = window;
  w.__pairDocument ??= crypto.randomUUID();
  /** The account's own fence entries, as their exact serialised form (an entry replaced by another is a change too). */
  const fencesNow = async () => {
    const records = await w.__atlasFixture?.session?.readRecords?.();
    const fences = records?.auth_state?.fences;
    if (!records || (fences !== undefined && typeof fences !== "object"))
      throw new Error("the auth fences are not readable");
    return JSON.stringify(fences?.[who] ?? []);
  };
  let before = null;
  let after = null;
  let authError = null;
  try {
    before = await fencesNow();
  } catch (error) {
    authError = text(error);
  }
  let rendering;
  let notice = null;
  // ---- ONE synchronous turn: nothing in this block awaits ----
  try {
    if (typeof w.__s?.view?.get !== "function")
      throw new Error("the session view is not readable");
    const view = w.__s.view.get();
    if (!view || typeof view.kind !== "string")
      throw new Error("the session view is not readable");
    const root = document.getElementById("protected-root");
    const visible = (el) => {
      const box = el.getBoundingClientRect();
      if (!(box.width > 0 && box.height > 0)) return false;
      if (typeof el.checkVisibility === "function")
        return el.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        });
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.opacity !== "0";
    };
    const placeholders = root
      ? Array.from(root.querySelectorAll("[data-cache-gate]"))
      : [];
    const host = w.__atlasFixture?.session?.leader?.() ?? null;
    if (!host || typeof host.attachment !== "string")
      throw new Error("the page's data attachment is not readable");
    rendering = {
      status: "observed",
      document: w.__pairDocument,
      attachment: host.attachment,
      view: {
        kind: view.kind,
        account_id: view.account_id ?? null,
        state: view.state ?? null,
      },
      root: root
        ? {
            present: true,
            gated:
              root.hasAttribute("inert") &&
              root.getAttribute("aria-hidden") === "true",
            mounted: root.childElementCount > 0,
          }
        : { present: false, gated: false, mounted: false },
      placeholders: {
        present: placeholders.length,
        refreshing_visible: placeholders.filter(
          (el) =>
            el.getAttribute("data-cache-gate") === "refreshing" && visible(el),
        ).length,
      },
    };
    notice = host.notice ?? null;
  } catch (error) {
    rendering = { status: "unavailable", error: text(error) };
    notice = null;
  }
  // ---- end of the capture ----
  try {
    after = await fencesNow();
  } catch (error) {
    authError ??= text(error);
  }
  const auth =
    authError !== null
      ? { status: "unavailable", error: authError }
      : before === after
        ? { status: "stable" }
        : {
            status: "changed",
            reason: "the account's auth fences changed during the capture",
          };
  return {
    rendering,
    notice,
    // The account's own auth fences (an invalid_session fence stands until the recovery finishes and clears it), in force throughout the
    // capture; null whenever the bracket is not stable.
    fenced: auth.status === "stable" ? JSON.parse(before).length > 0 : null,
    auth,
  };
}

/**
 * One page's rendering and auth bracket (`captureInPage` in one evaluation of its own document). A page that cannot be evaluated (closed,
 * navigating) is UNAVAILABLE for both — a failed observation, never a hidden or open page, and never a "change".
 */
export async function renderingOf(page, account) {
  try {
    return await page.evaluate(captureInPage, account);
  } catch (error) {
    const m = message(error);
    return {
      rendering: { status: "unavailable", error: m },
      notice: null,
      fenced: null,
      auth: { status: "unavailable", error: m },
    };
  }
}

/** The storage bracket from the two stored reads (`after` null: no database at the second read; `error`: the second read failed). */
export function storageBracket(before, after, error = null) {
  if (error !== null)
    return {
      status: "unavailable",
      reason: `the stored state could not be read again: ${error}`,
    };
  if (after === null || after === undefined)
    return {
      status: "unavailable",
      reason: "the account database was not found at the second read",
    };
  if (after.incarnation !== before.incarnation)
    return {
      status: "replaced",
      reason: "the account database is another incarnation at the second read",
      incarnation_after: after.incarnation ?? null,
    };
  const fields = STAMP_FIELDS.filter(
    (k) =>
      JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
  return fields.length === 0
    ? { status: "stable" }
    : {
        status: "changed",
        fields,
        before: pick(before, fields),
        after: pick(after, fields),
      };
}

/**
 * One reader's sample: its stored state (`io.stored(rows, local)`, raw IndexedDB in one read-only transaction), its rendering and auth
 * bracket (`io.rendering()`, i.e. `renderingOf`), and the stored state read AGAIN after the capture (the storage bracket). The stored
 * fields are the FIRST read's; the brackets say whether the rendering may be associated with them. A missing database at the first read
 * throws (no sample at all); everything else is reported in the sample for the observer to judge — nothing here decides to re-read.
 */
export async function recoverySample(
  io,
  { reader, page, account, rows = false, local = null },
) {
  const s = await io.stored(rows, local);
  if (!s) throw new Error(`the ${reader} has no account database`);
  const seen = await io.rendering();
  let again = null;
  let error = null;
  try {
    again = await io.stored(false, null);
  } catch (e) {
    error = message(e);
  }
  return {
    ...s,
    reader,
    page,
    account,
    rendering: seen?.rendering,
    notice: seen?.notice ?? null,
    fenced: seen?.auth?.status === "stable" ? seen.fenced : null,
    capture: {
      auth: seen?.auth ?? null,
      storage: storageBracket(s, again, error),
    },
  };
}
