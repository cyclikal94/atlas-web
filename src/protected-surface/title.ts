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

/** The public surfaces' own generic titles: a closed set, nothing about any account. */
export type NeutralTitlePart = "Sign in" | "Join";

export function setNeutralTitle(
  doc: Document = document,
  part?: NeutralTitlePart,
): void {
  doc.title = part ? `${part} · ${NEUTRAL_TITLE}` : NEUTRAL_TITLE;
}

/**
 * A public surface leaving: put the plain neutral title back, but only if the title is still the one that surface set. The protected
 * tree may already have set its own (the surface unmounts as the tree mounts), and that must not be overwritten.
 */
export function clearNeutralTitle(
  part: NeutralTitlePart,
  doc: Document = document,
): void {
  if (doc.title === `${part} · ${NEUTRAL_TITLE}`) setNeutralTitle(doc);
}

const titleOf = (parts: readonly string[]): string =>
  [...parts, NEUTRAL_TITLE].join(" · ");

/** The destination a gated page asked for; page memory only, applied when the gate lifts over the SAME tree. */
let pendingParts: readonly string[] | null = null;

/** No-op while the protected root is gated; the neutral title stays and the request is remembered. */
export function setProtectedTitle(
  parts: readonly string[],
  doc: Document = document,
): void {
  if (protectedSurfaceIsGated(doc)) {
    pendingParts = parts;
    return;
  }
  pendingParts = null;
  doc.title = titleOf(parts);
}

/** Called by the session after it lifts the gate: shows the title the tree asked for while it was gated. */
export function restoreProtectedTitle(doc: Document = document): void {
  if (pendingParts && !protectedSurfaceIsGated(doc)) {
    doc.title = titleOf(pendingParts);
    pendingParts = null;
  }
}

/** Called when the tree is unmounted: a title requested by a tree that no longer exists is discarded. */
export function forgetProtectedTitle(): void {
  pendingParts = null;
}
