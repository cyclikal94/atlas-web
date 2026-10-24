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

  /**
   * Focus generation: a newer mount, a level-0 gate or an unmount cancels a pending heading focus. WEB-08c revision 3 (R8, HF-13): the
   * level-0 gate did not advance it, and a deferred attempt focused the heading even when focus had already been moved inside the tree,
   * so a heading attempt still waiting from the mount could run AFTER a lift had returned focus to the person's control and take it
   * (the original assertion then read focus key `null`). A restoring lift always follows the gate, which cancels the attempt; a deferred
   * attempt also leaves alone any focus already inside the tree.
   */
  let focusToken = 0;
  const focusHeading = () => {
    const token = ++focusToken;
    const attempt = (framesLeft: number, deferred: boolean) => {
      if (token !== focusToken || !mounted) return;
      const active = doc.activeElement;
      const moved =
        active instanceof HTMLElement &&
        active !== doc.body &&
        root().contains(active);
      // A DEFERRED attempt never takes focus the person (or a restoration) has already moved somewhere inside the tree: the heading
      // is the default target only while nothing in the tree has been chosen.
      if (deferred && moved) return;
      const heading = root().querySelector<HTMLElement>("h1");
      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
        heading.focus();
        return;
      }
      // The router renders its route after the synchronous commit: wait for the heading (bounded), unless the person
      // has already moved focus somewhere inside the tree.
      if (framesLeft > 0 && !moved)
        win.requestAnimationFrame(() => attempt(framesLeft - 1, true));
    };
    attempt(120, false);
  };

  return {
    applyLevel0() {
      const protectedRoot = root();
      applyGate(protectedRoot);
      setNeutralTitle(doc);
      deps.liveRegions.clearAll();
      // Focus leaves the protected tree, so an open tooltip or menu that closes on blur does.
      const active = doc.activeElement;
      if (active instanceof HTMLElement && protectedRoot.contains(active))
        active.blur();
      // The gate owns focus until the lift: a heading attempt still waiting from the mount is obsolete (HF-13).
      focusToken += 1;
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
        if (target) target.focus();
        else focusHeading();
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
