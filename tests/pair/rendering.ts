import type { Page } from "@playwright/test";

// WEB-09c revision 28 (R28-DIAG.b; design assessment C2/Q3): the RENDERING adapter of the recovery observer, kept on its own (no pair
// runner state, bridge or evidence at import) so the maintained function itself is qualified against the real fixture DOM in every engine
// (tests/e2e/fixture.pair-rendering.spec.ts) and used unchanged by the pair spec (tests/pair/support.ts `recoveryReader`).

/**
 * Revision 28 (R28-DIAG.b, design assessment C2): one page's RENDERING, read in ONE evaluation of its own document — the session's view
 * (its real discriminant), #protected-root (gated = inert AND aria-hidden="true"; mounted = it has children), the cache gate's placeholders
 * inside it (present, and those actually VISIBLE: `checkVisibility` with opacity and CSS visibility, and a non-empty box), the page's data
 * attachment, the leader's job notice, the account's auth fences, and a per-document identity (minted once per document, so a reload or a
 * replaced page is another document). Any failure makes the observation `unavailable` with its error — never an open or a hidden page.
 */
/**
 * Revision 29 (R29-DIAG; design assessment C5/Q8): one BRACKETED sample. Revision 28 read the session view, then awaited the auth records,
 * then read the protected root and the placeholders lazily — three moments in one evaluation, so a legitimate finish between them could
 * pair a stale fence with a later DOM (a spurious safety failure) or a stale view with a later root. Now the account's fences are read
 * BEFORE and AFTER one synchronous capture of everything the page shows (view, attachment, notice, root, placeholders and their
 * visibility, all computed eagerly in the same turn). Equal fence entries at both ends make the sample COHERENT (`coherent: true`): the
 * fence the capture is judged against is the one in force throughout it. Differing entries make it `coherent: false` with the reason —
 * never judged, never hidden or shown (pair-recovery.mjs re-reads it, bounded and counted).
 */
export async function renderingOf(page: Page, account: string) {
  try {
    return await page.evaluate(async (who) => {
      const w = window as unknown as {
        __pairDocument?: string;
        __s?: { view?: { get?: () => unknown } };
        __atlasFixture?: {
          session?: {
            leader?: () => {
              attachment?: string;
              notice?: { reason?: string } | null;
            } | null;
            readRecords?: () => Promise<{
              auth_state?: { fences?: Record<string, unknown[]> };
            }>;
          };
        };
      };
      w.__pairDocument ??= crypto.randomUUID();
      if (typeof w.__s?.view?.get !== "function")
        throw new Error("the session view is not readable");
      /** The account's own fence entries, as their exact serialised form (an entry replaced by another is a change too). */
      const fencesNow = async () => {
        const records = await w.__atlasFixture?.session?.readRecords?.();
        const fences = records?.auth_state?.fences;
        if (!records || (fences !== undefined && typeof fences !== "object"))
          throw new Error("the auth fences are not readable");
        return JSON.stringify(fences?.[who] ?? []);
      };
      const before = await fencesNow();
      // ---- ONE synchronous turn: nothing below awaits until the capture is complete ----
      const view = w.__s?.view?.get?.() as
        | { kind?: string; account_id?: string; state?: string }
        | undefined;
      if (!view || typeof view.kind !== "string")
        throw new Error("the session view is not readable");
      const root = document.getElementById("protected-root");
      const visible = (el: Element) => {
        const box = el.getBoundingClientRect();
        if (!(box.width > 0 && box.height > 0)) return false;
        const check = (
          el as Element & {
            checkVisibility?: (o: object) => boolean;
          }
        ).checkVisibility;
        if (typeof check === "function")
          return check.call(el, {
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
      const rendering = {
        status: "observed" as const,
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
              el.getAttribute("data-cache-gate") === "refreshing" &&
              visible(el),
          ).length,
        },
      };
      const notice = host.notice ?? null;
      // ---- end of the capture ----
      const after = await fencesNow();
      const coherent = before === after;
      return {
        rendering,
        notice,
        // The account's own auth fences (an invalid_session fence stands until the recovery finishes and clears it), in force throughout
        // the capture; null when they changed during it (the sample is then incoherent).
        fenced: coherent ? (JSON.parse(before) as unknown[]).length > 0 : null,
        coherent,
        incoherence: coherent
          ? null
          : "the account's auth fences changed during the capture",
      };
    }, account);
  } catch (error) {
    return {
      rendering: {
        status: "unavailable" as const,
        error: String((error as Error)?.message ?? error).slice(0, 300),
      },
      notice: null,
      fenced: null,
      // An unavailable observation is incomplete (not incoherent): it is refused, never re-read.
      coherent: true,
      incoherence: null,
    };
  }
}
