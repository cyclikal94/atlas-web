import { getProtectedRoot, isGated } from "./gate";

/**
 * document.title is protected surface (matrix section 3.7.1): the tab title can reveal what is open.
 * This is the only module that may write it (lint rule R5). Titles are generic destination names, never account data.
 */

const NEUTRAL_TITLE = "Atlas";

function protectedSurfaceIsGated(doc: Document): boolean {
  try {
    return isGated(getProtectedRoot(doc));
  } catch {
    // No protected root means nothing may be shown: fail closed.
    return true;
  }
}

export function setNeutralTitle(doc: Document = document): void {
  doc.title = NEUTRAL_TITLE;
}

/** No-op while the protected root is gated; the neutral title stays. */
export function setProtectedTitle(
  parts: readonly string[],
  doc: Document = document,
): void {
  if (protectedSurfaceIsGated(doc)) return;
  doc.title = [...parts, NEUTRAL_TITLE].join(" · ");
}
