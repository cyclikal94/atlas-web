import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { commitSync } from "../components/ui/sync-commit";

/**
 * Gate primitives for #protected-root (account-lifecycle matrix, section 3.7). WEB-07 ships only the mechanism.
 * WEB-08a decides when to lift or apply it. Lint rule R4 restricts importers to src/session/** and
 * src/fixture/**, so production code cannot reach these functions.
 */

export function getProtectedRoot(doc: Document = document): HTMLElement {
  const root = doc.getElementById("protected-root");
  if (!root) throw new Error("Missing #protected-root");
  return root;
}

/** A root is gated only when it is both inert and hidden from assistive technology. */
export function isGated(root: HTMLElement): boolean {
  return (
    root.hasAttribute("inert") && root.getAttribute("aria-hidden") === "true"
  );
}

export function applyGate(root: HTMLElement): void {
  root.setAttribute("inert", "");
  root.setAttribute("aria-hidden", "true");
}

export function liftGate(root: HTMLElement): void {
  root.removeAttribute("inert");
  root.removeAttribute("aria-hidden");
}

/** Mounts the protected React tree into the root. Returns the unmount function. */
export function mountProtectedTree(
  root: HTMLElement,
  node: ReactNode,
): () => void {
  const reactRoot = createRoot(root);
  reactRoot.render(node);
  return () => reactRoot.unmount();
}

/**
 * The same, committed SYNCHRONOUSLY: when this returns the tree is in the DOM and its effects have run. `act` (matrix
 * 3.6.3) mounts and releases the exposure lock in one synchronous step, so the mount cannot be left to React's scheduler.
 */
export function mountProtectedTreeSync(
  root: HTMLElement,
  node: ReactNode,
): () => void {
  const reactRoot = createRoot(root);
  commitSync(() => reactRoot.render(node));
  return () => commitSync(() => reactRoot.unmount());
}
