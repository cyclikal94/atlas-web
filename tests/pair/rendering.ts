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
      const records = await w.__atlasFixture?.session?.readRecords?.();
      const fences = records?.auth_state?.fences;
      if (!records || (fences !== undefined && typeof fences !== "object"))
        throw new Error("the auth fences are not readable");
      return {
        rendering: {
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
        },
        notice: host.notice ?? null,
        // The account's own auth fences (an invalid_session fence stands until the recovery finishes and clears it).
        fenced: (fences?.[who] ?? []).length > 0,
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
    };
  }
}
