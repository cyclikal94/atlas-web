/**
 * Modal behaviour without a style element. Radix's modal dialog locks scrolling by injecting a <style> element, which the
 * production content security policy (style-src 'self') refuses, and the policy is not relaxed to suit a component. So the
 * dialog is non-modal in Radix terms and this module supplies the modality itself, using only attributes and CSSOM
 * writes, both of which the policy allows:
 *  - everything beside the portal container becomes inert and aria-hidden (the page behind an open dialog is inert,
 *    ia.md section 3), except live regions, so announcements still reach assistive technology;
 *  - the document stops scrolling behind the dialog.
 * Both are reference-counted so a second dialog (or React StrictMode's double effect) restores state exactly once.
 */

interface Saved {
  count: number;
  ariaHidden: string | null;
  inert: boolean;
}
const background = new Map<Element, Saved>();
let scrollLocks = 0;
let savedBody = { overflow: "", paddingRight: "" };

function isLiveRegion(element: Element): boolean {
  return (
    element.hasAttribute("aria-live") ||
    element.querySelector("[aria-live]") !== null
  );
}

/** Returns the function that undoes this call. `portalRoot` is the registered portal container. */
export function enterModal(portalRoot: HTMLElement): () => void {
  const host = portalRoot.parentElement;
  const targets = host
    ? Array.from(host.children).filter(
        (child) => child !== portalRoot && !isLiveRegion(child),
      )
    : [];
  for (const element of targets) {
    const entry = background.get(element);
    if (entry) {
      entry.count += 1;
      continue;
    }
    background.set(element, {
      count: 1,
      ariaHidden: element.getAttribute("aria-hidden"),
      inert: element.hasAttribute("inert"),
    });
    element.setAttribute("inert", "");
    element.setAttribute("aria-hidden", "true");
  }

  if (scrollLocks === 0) {
    const { body, documentElement } = document;
    savedBody = {
      overflow: body.style.overflow,
      paddingRight: body.style.paddingRight,
    };
    const gap = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (gap > 0) body.style.paddingRight = `${gap}px`;
  }
  scrollLocks += 1;

  return () => {
    for (const element of targets) {
      const entry = background.get(element);
      if (!entry) continue;
      entry.count -= 1;
      if (entry.count > 0) continue;
      background.delete(element);
      if (!entry.inert) element.removeAttribute("inert");
      if (entry.ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", entry.ariaHidden);
    }
    scrollLocks -= 1;
    if (scrollLocks === 0) {
      document.body.style.overflow = savedBody.overflow;
      document.body.style.paddingRight = savedBody.paddingRight;
    }
  };
}
