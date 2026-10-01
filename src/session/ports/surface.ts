import type { AccountId, Epoch } from "../model/types";

/**
 * The only holder of the gate primitives (lint rule R4). Every method is synchronous. `attachTree` is the exposure:
 * it is called only from `act` (rule R10).
 */
export interface ProtectedSurface {
  /** inert + aria-hidden on #protected-root, neutral title, live regions cleared, modal gate dialog opened last. */
  applyLevel0(): void;
  /** Level 1: nothing protected remains. */
  unmountTree(): void;
  /** Mounts, or lifts the gate over a mounted tree, and restores focus and scroll only for the same account. */
  attachTree(account: AccountId, epoch: Epoch): "mounted" | "lifted";
  /** Page memory only; `data-focus-key`, never text or value. */
  saveFocusAndScroll(account: AccountId, epoch: Epoch): void;
  discardSavedPosition(): void;
}
