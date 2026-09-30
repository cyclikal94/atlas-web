/**
 * Keeps keyboard focus inside an open dialog. Radix's non-modal dialog is used (see modal-background.ts), and its focus loop
 * ignores any Tab that carries Option or Alt. In macOS Safari, where Tab reaches links and buttons only while Option is held
 * (the "Press Tab to highlight each item" setting is off by default), that is the keystroke a keyboard user relies on, so
 * from the last control focus escaped through Radix's two invisible focus guards and the page behind.
 *
 * This wraps Tab and Shift+Tab, with or without Option or Alt, from the last control to the first and back. It is a key
 * handler and focus calls only: nothing here injects a style element or a script, so the content security policy is unchanged.
 * Ctrl and Cmd combinations are left to the browser (Ctrl+Tab and Cmd+Tab switch tabs and applications).
 */

const CANDIDATES =
  'a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]:not([contenteditable="false"])';

function isHidden(element: HTMLElement, container: HTMLElement): boolean {
  if (getComputedStyle(element).visibility === "hidden") return true;
  for (
    let node: HTMLElement | null = element;
    node && node !== container.parentElement;
    node = node.parentElement
  ) {
    if (getComputedStyle(node).display === "none") return true;
  }
  return false;
}

/** The elements Tab visits inside `container`, in DOM order (positive tabindex values are not used in this application). */
export function tabbableWithin(container: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>(CANDIDATES),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute("disabled") &&
      !(element instanceof HTMLInputElement && element.type === "hidden") &&
      !element.closest("[inert]") &&
      !isHidden(element, container),
  );
  // A native radio group is one tab stop: the checked button, or the first when none is checked.
  const radios = candidates.filter(
    (element): element is HTMLInputElement =>
      element instanceof HTMLInputElement &&
      element.type === "radio" &&
      element.name !== "",
  );
  const skip = new Set<HTMLElement>();
  for (const radio of radios) {
    const group = radios.filter(
      (other) => other.name === radio.name && other.form === radio.form,
    );
    const stop = group.find((other) => other.checked) ?? group[0];
    if (radio !== stop) skip.add(radio);
  }
  return candidates.filter((element) => !skip.has(element));
}

/** Wraps a Tab keydown that would leave `container`. Returns whether it took the key. */
export function loopTab(event: KeyboardEvent, container: HTMLElement): boolean {
  if (
    event.key !== "Tab" ||
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey
  )
    return false;
  const active = document.activeElement;
  // Another dialog on top owns the keyboard.
  const owner = active?.closest('[role="dialog"]');
  if (owner && owner !== container) return false;

  const stops = tabbableWithin(container);
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) {
    event.preventDefault();
    container.focus();
    return true;
  }
  const forward = !event.shiftKey;
  const inside = active !== null && container.contains(active);
  const leaving = !inside
    ? true
    : forward
      ? active === last
      : active === first || active === container;
  if (!leaving) return false;
  event.preventDefault();
  (forward ? first : last).focus();
  return true;
}

/** Starts the loop for one open dialog. Returns the function that stops it. */
export function enterFocusLoop(container: HTMLElement): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!container.isConnected) return;
    loopTab(event, container);
  };
  // Captured on the document so that a Tab pressed while focus is on the page body or a focus guard is also brought back in.
  document.addEventListener("keydown", onKeyDown, true);
  return () => document.removeEventListener("keydown", onKeyDown, true);
}
