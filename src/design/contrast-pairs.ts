import type { TokenName } from "./tokens.ts";

/** WCAG minimums: normal text 4.5, non-text user-interface components and focus indicators 3. */
export type PairKind = "text" | "non-text";
export interface DeclaredPair {
  fg: TokenName;
  bg: TokenName;
  kind: PairKind;
  /** Where the pair is used, so the generated documentation is reviewable. */
  use: string;
}

function pairs(
  fgs: readonly TokenName[],
  bgs: readonly TokenName[],
  kind: PairKind,
  use: string,
): DeclaredPair[] {
  return fgs.flatMap((fg) => bgs.map((bg) => ({ fg, bg, kind, use })));
}

/**
 * Every foreground on every surface it is used on. A theme pasted from tweakcn is held to the same pairs, so a palette that
 * cannot be read fails the guard rather than shipping.
 */
export const declaredPairs: readonly DeclaredPair[] = [
  ...pairs(
    ["foreground"],
    ["background", "card", "popover", "secondary", "muted", "accent"],
    "text",
    "Body text on every surface",
  ),
  ...pairs(
    ["muted-foreground"],
    ["background", "card", "popover", "muted", "secondary"],
    "text",
    "Secondary text, placeholders and descriptions",
  ),
  ...pairs(["primary-foreground"], ["primary"], "text", "Primary button label"),
  ...pairs(
    ["secondary-foreground"],
    ["secondary"],
    "text",
    "Secondary button label",
  ),
  ...pairs(
    ["accent-foreground"],
    ["accent"],
    "text",
    "Text on the accent tint (selected rows, hover)",
  ),
  ...pairs(
    ["destructive-foreground"],
    ["destructive"],
    "text",
    "Destructive button label",
  ),
  ...pairs(["success-foreground"], ["success"], "text", "Done badge label"),
  ...pairs(["warning-foreground"], ["warning"], "text", "Missed badge label"),
  ...pairs(
    ["primary", "destructive", "success", "warning"],
    ["background", "card"],
    "text",
    "Links, accent text and state text on the page and on cards",
  ),
  ...pairs(
    ["sidebar-foreground"],
    ["sidebar", "sidebar-accent"],
    "text",
    "Navigation labels, at rest and hovered",
  ),
  ...pairs(
    ["sidebar-accent-foreground"],
    ["sidebar-accent"],
    "text",
    "The active navigation label",
  ),
  ...pairs(
    ["sidebar-primary-foreground"],
    ["sidebar-primary"],
    "text",
    "Text on the sidebar's primary fill",
  ),
  // Non-text (3:1)
  ...pairs(
    ["input"],
    ["background", "card"],
    "non-text",
    "Input border against the page and against a card (WCAG 1.4.11; Q17)",
  ),
  ...pairs(
    ["ring"],
    ["background", "card"],
    "non-text",
    "Focus ring (2px, 2px offset: it sits on the surface beneath the control)",
  ),
  ...pairs(
    ["primary"],
    ["background", "card"],
    "non-text",
    "Selected radio dot, active markers and the done bar",
  ),
];

export const minimumFor = (kind: PairKind): number =>
  kind === "text" ? 4.5 : 3;

/** Input fills that are permitted: the input border is declared against these surfaces. */
export const inputFillSurfaces: readonly TokenName[] = ["background", "card"];
