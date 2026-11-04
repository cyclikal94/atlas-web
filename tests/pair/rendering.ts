import type { Page } from "@playwright/test";
import { renderingOf as maintained } from "../../scripts/integration/pair-capture.mjs";
import type { RecoveryRendering } from "../../scripts/integration/pair-recovery.mjs";

// WEB-09c revision 28 (R28-DIAG.b; design assessment C2/Q3): the RENDERING adapter of the recovery observer. Revision 30 (R30-DIAG;
// design assessment C1/C5): its body moved, unchanged in what it captures, to scripts/integration/pair-capture.mjs (`captureInPage`,
// `renderingOf`) so deterministic tests drive the very code the pair spec and the native qualification (tests/e2e/fixture.pair-rendering.
// spec.ts) use. The rendering's availability and the auth bracket are now SEPARATE outcomes (revision 29 returned `coherent: true` for an
// unavailable rendering, to force its refusal, and `coherent: false` for a changed fence).

/** One page's capture: its rendering, the leader's notice, the fence (null unless the auth bracket is stable) and the auth bracket. */
export interface RenderingCapture {
  rendering: RecoveryRendering;
  notice: { reason?: string } | null;
  fenced: boolean | null;
  auth:
    | { status: "stable" }
    | { status: "changed"; reason: string }
    | { status: "unavailable"; error: string };
}

export const renderingOf = (page: Page, account: string) =>
  maintained(page, account) as Promise<RenderingCapture>;
