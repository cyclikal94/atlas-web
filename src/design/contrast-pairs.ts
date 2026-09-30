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

const TEXT_SURFACES: readonly TokenName[] = [
  "canvas",
  "panel",
  "raised",
  "chrome",
  "chrome-inset",
  "inset",
  "tab-bar",
  "row-hover",
  "rail-hover",
  "nav-active",
  "select-tint",
  "action-tint",
];

/** ink-3 is not permitted on every surface (findings F3); these are the surfaces that carry it. */
const INK_3_SURFACES: readonly TokenName[] = [
  "canvas",
  "panel",
  "raised",
  "chrome",
  "inset",
  "tab-bar",
  "row-hover",
];

function pairs(
  fgs: readonly TokenName[],
  bgs: readonly TokenName[],
  kind: PairKind,
  use: string,
): DeclaredPair[] {
  return fgs.flatMap((fg) => bgs.map((bg) => ({ fg, bg, kind, use })));
}

export const declaredPairs: readonly DeclaredPair[] = [
  ...pairs(
    ["ink-1", "ink-2"],
    TEXT_SURFACES,
    "text",
    "Body and secondary text",
  ),
  ...pairs(
    ["ink-3"],
    INK_3_SURFACES,
    "text",
    "Tertiary text and placeholders (not on the tinted surfaces)",
  ),
  ...pairs(
    ["action-ink"],
    ["canvas", "panel", "raised", "chrome", "action-tint"],
    "text",
    "Links and accent text",
  ),
  ...pairs(
    ["action-on"],
    ["action-fill", "action-hover"],
    "text",
    "Primary button label",
  ),
  ...pairs(
    ["done"],
    ["canvas", "panel", "chrome-inset", "done-tint"],
    "text",
    "Done state text",
  ),
  ...pairs(
    ["missed"],
    ["canvas", "panel", "chrome-inset", "missed-tint"],
    "text",
    "Missed state text",
  ),
  ...pairs(
    ["conflict"],
    ["canvas", "panel", "chrome-inset", "conflict-tint"],
    "text",
    "Conflict state text",
  ),
  ...pairs(
    ["conflict-text"],
    ["conflict-tint"],
    "text",
    "Body copy inside a conflict panel",
  ),
  ...pairs(
    ["ink-1"],
    ["done-tint", "missed-tint", "conflict-tint"],
    "text",
    "Body copy inside state panels",
  ),
  // Non-text (3:1)
  ...pairs(
    ["field-edge"],
    ["canvas", "panel"],
    "non-text",
    "Input border; inputs fill only from canvas or panel (F1)",
  ),
  ...pairs(
    ["field-edge"],
    ["panel", "canvas"],
    "non-text",
    "Unselected radio-card ring (F5)",
  ),
  ...pairs(
    ["action-ink"],
    ["canvas", "panel", "raised", "chrome"],
    "non-text",
    "Focus ring (2px, 2px offset: it sits on the surface beneath the control)",
  ),
  ...pairs(
    ["action-fill"],
    ["canvas", "panel"],
    "non-text",
    "Selected radio dot and selected card border",
  ),
  ...pairs(
    ["action-ink"],
    ["nav-active"],
    "non-text",
    "Active navigation marker (F6)",
  ),
  ...pairs(
    ["done", "missed", "conflict", "action-ink"],
    ["chrome-inset"],
    "non-text",
    "Sync chip status dot",
  ),
  ...pairs(
    ["withheld"],
    ["chrome-inset"],
    "non-text",
    "Sync chip muted dot (never text, F4)",
  ),
];

export const minimumFor = (kind: PairKind): number =>
  kind === "text" ? 4.5 : 3;

/** Input fills that are permitted, because light field-edge is below 3:1 on raised and chrome (F1). */
export const inputFillSurfaces: readonly TokenName[] = ["canvas", "panel"];
