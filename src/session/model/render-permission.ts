import type { AttemptPhase, Fence } from "./types";

/**
 * Render permission (matrix 3.7): a pure function of the durable local state and this page's memory. Nothing here
 * reads a lock, a network answer or a clock. The clause about other pages' leases is decided INSIDE the exposure's
 * cover transaction (Ex1, Ex3) and appears here only as the `exposureLease` input: the page is displaying the
 * account under an exposure lease that it acted on.
 */
export interface RenderInput {
  /** `settled.account_id == X`. */
  settledMatches: boolean;
  /** `attempt.phase`, or null when there is no attempt. */
  attemptPhase: AttemptPhase | null;
  /** `fences[X]`. */
  fences: readonly Pick<Fence, "kind">[];
  /** Any in-memory hold for X in this page. */
  hold: boolean;
  /** This page is displaying X under an exposure lease it acted on, and has not closed X since. */
  exposureLease: boolean;
}

export type RenderClause =
  | "settled"
  | "attempt"
  | "fences"
  | "hold"
  | "exposure_lease";

/** The first failing clause, in the matrix's order, or null when every clause holds. */
export function firstFailingClause(input: RenderInput): RenderClause | null {
  if (!input.settledMatches) return "settled";
  if (
    input.attemptPhase !== null &&
    input.attemptPhase !== "exchanging" &&
    input.attemptPhase !== "redirected"
  )
    return "attempt";
  if (input.fences.length > 0) return "fences";
  if (input.hold) return "hold";
  if (!input.exposureLease) return "exposure_lease";
  return null;
}

export const mayRender = (input: RenderInput): boolean =>
  firstFailingClause(input) === null;
