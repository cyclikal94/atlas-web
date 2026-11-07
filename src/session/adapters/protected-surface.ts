import type { ReactNode } from "react";
import {
  applyGate,
  getProtectedRoot,
  liftGate,
  mountProtectedTreeSync,
} from "../../protected-surface/gate";
import {
  forgetProtectedTitle,
  restoreProtectedTitle,
  setNeutralTitle,
} from "../../protected-surface/title";
import type { AccountId, Epoch } from "../model/types";
import type { ProtectedSurface } from "../ports/surface";

/**
 * The ONLY file that imports the gate primitives (lint rule R4). It turns the `ProtectedSurface` port into DOM effects
 * on `#protected-root`. Every method is synchronous: the level-0 gate closes inside the `visibilitychange` and `pagehide`
 * handlers, and `attachTree` runs inside `act`, in the same step that releases the exposure lock. The collaborators that
 * are UI (the modal gate dialog, the live regions, the tree itself) are injected by the composition root, so this module
 * imports no component.
 */
export interface ProtectedSurfaceDeps {
  doc?: Document;
  /** The tree that `act` mounts. Loaded BEFORE `expose` starts (decision D-10), so mounting never awaits. */
  renderTree(account: AccountId, epoch: Epoch): ReactNode;
  gateDialog: {
    open(): void;
    close(): void;
    focusHeading(): void;
  };
  liveRegions: {
    clearAll(): void;
    announce(message: string, politeness?: "polite" | "assertive"): void;
  };
}

interface SavedPosition {
  account: AccountId;
  epoch: Epoch;
  /** `data-focus-key` of the focused control, never its text or value. */
  focusKey: string | null;
  scrollX: number;
  scrollY: number;
}

export const DIFFERENT_ACCOUNT_MESSAGE =
  "This window now shows a different account.";

export function createProtectedSurface(
  deps: ProtectedSurfaceDeps,
): ProtectedSurface {
  const doc = deps.doc ?? document;
  const win = doc.defaultView ?? window;
  let mounted: { account: AccountId; unmount: () => void } | null = null;
  let saved: SavedPosition | null = null;
  /** The account this page showed last, page memory only: a different one is announced once (no name). */
  let lastShown: AccountId | null = null;

  const root = () => getProtectedRoot(doc);

  /** Focus generation: a newer mount, lift, gate or unmount cancels a pending focus. */
  let focusToken = 0;
  /**
   * The heading is a FALLBACK (revision 19, R27): it never overrides focus that something in the tree has already placed (a restored
   * form's first field, an update action, a dialog, the person), whether that happened before this mount's attempt or while it waited for
   * the router to render the heading. Every attempt checks that first, and a focus into the tree meanwhile ends the wait even if the focused
   * control has gone since.
   */
  const focusHeading = () => {
    const token = ++focusToken;
    const tree = root();
    let claimed = false;
    const claim = () => {
      claimed = true;
    };
    tree.addEventListener("focusin", claim);
    const attempt = (framesLeft: number) => {
      const active = doc.activeElement;
      if (
        token !== focusToken ||
        !mounted ||
        claimed ||
        (active !== doc.body && tree.contains(active)) ||
        framesLeft < 0
      ) {
        tree.removeEventListener("focusin", claim);
        return;
      }
      const heading = tree.querySelector<HTMLElement>("h1");
      if (!heading) {
        // The router renders its route after the synchronous commit: wait for the heading (bounded).
        win.requestAnimationFrame(() => attempt(framesLeft - 1));
        return;
      }
      tree.removeEventListener("focusin", claim);
      if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
      heading.focus();
    };
    attempt(120);
  };

  return {
    applyLevel0() {
      const protectedRoot = root();
      applyGate(protectedRoot);
      setNeutralTitle(doc);
      deps.liveRegions.clearAll();
      // A pending heading focus is the tree's: the gate owns focus now (revision 19, R27).
      focusToken += 1;
      // Focus leaves the protected tree, so an open tooltip or menu that closes on blur does.
      const active = doc.activeElement;
      if (active instanceof HTMLElement && protectedRoot.contains(active))
        active.blur();
      // The modal dialog is opened LAST so it is the topmost modal dialog.
      deps.gateDialog.open();
      deps.gateDialog.focusHeading();
    },

    unmountTree() {
      const protectedRoot = root();
      applyGate(protectedRoot);
      setNeutralTitle(doc);
      deps.liveRegions.clearAll();
      forgetProtectedTitle();
      const current = mounted;
      mounted = null;
      focusToken += 1;
      current?.unmount();
      // Nothing protected remains, so the neutral state beneath is what the person sees and uses.
      deps.gateDialog.close();
    },

    attachTree(account, epoch) {
      const protectedRoot = root();
      let result: "mounted" | "lifted";
      if (mounted && mounted.account !== account) {
        // The settled account changed while the old tree was still mounted: nothing of it survives.
        mounted.unmount();
        mounted = null;
        saved = null;
        forgetProtectedTitle();
      }
      if (mounted) {
        result = "lifted";
      } else {
        applyGate(protectedRoot);
        const unmount = mountProtectedTreeSync(
          protectedRoot,
          deps.renderTree(account, epoch),
        );
        mounted = { account, unmount };
        result = "mounted";
      }
      liftGate(protectedRoot);
      deps.gateDialog.close();
      restoreProtectedTitle(doc);
      // Focus and scroll are restored ONLY by a lift over the same account's tree, never after a change.
      const position = saved;
      saved = null;
      if (result === "lifted" && position && position.account === account) {
        const target = position.focusKey
          ? (Array.from(
              protectedRoot.querySelectorAll<HTMLElement>("[data-focus-key]"),
            ).find(
              (element) =>
                element.getAttribute("data-focus-key") === position.focusKey,
            ) ?? null)
          : null;
        if (target) {
          // The person's own place wins over a heading focus still pending from an earlier mount (revision 19, R27).
          focusToken += 1;
          target.focus();
        } else focusHeading();
        win.scrollTo(position.scrollX, position.scrollY);
      } else {
        focusHeading();
        if (lastShown !== null && lastShown !== account)
          deps.liveRegions.announce(DIFFERENT_ACCOUNT_MESSAGE, "polite");
      }
      lastShown = account;
      return result;
    },

    saveFocusAndScroll(account, epoch) {
      const active = doc.activeElement;
      const keyed =
        active instanceof HTMLElement
          ? active.closest<HTMLElement>("[data-focus-key]")
          : null;
      saved = {
        account,
        epoch,
        focusKey: keyed?.getAttribute("data-focus-key") ?? null,
        scrollX: win.scrollX,
        scrollY: win.scrollY,
      };
    },

    discardSavedPosition() {
      saved = null;
    },
  };
}
