import { useLayoutEffect } from "react";

/**
 * The mobile header and the bottom tabs are sticky, so content scrolls beneath them. A browser scrolls a focused control (or a
 * fragment target) only until it is inside the viewport, which can leave it under a bar: WCAG 2.4.11 Focus Not Obscured, and
 * technique C43. The document is the scroller, so `scroll-padding` on the root element (base.css) keeps the browser clear of
 * both bars. Their heights are not fixed (the status label can wrap, and the bottom bar adds the safe-area inset), so they
 * are measured rather than assumed.
 *
 * `scroll-padding` alone is not enough for a text field in WebKit. When a text field takes focus WebKit reveals the caret's
 * rectangle, not the field, and applies the padding to that: the caret is clear of the bar but the rest of the 44px field and
 * its focus ring (about 13px) can sit behind it. Chromium and Firefox reveal the whole field. So a focus that lands in <main>
 * partly under a bar is revealed as a whole box, through the same padded scrollport (`scrollIntoView`, block "nearest": no
 * scroll at all when the field and its ring are already clear, so it changes nothing in an engine that got it right).
 *
 * The values are custom properties written through the CSSOM, which the content security policy allows (modal-background.ts
 * does the same for the body). They are removed on unmount, so a layout with no sticky bars adds no padding.
 */
const TOP = "--shell-inset-top";
const BOTTOM = "--shell-inset-bottom";
/** The focus ring is a 2px outline at a 2px offset (base.css); keep all of it clear of the bar, not only the control. */
const RING = 4;

/**
 * Scrolls `element` into view if its box plus its focus ring is not wholly between the bars (a bar that is not rendered is the
 * viewport edge). Exported for the unit tests, which supply the geometry that jsdom cannot.
 */
export function revealIfObscured(
  element: Element,
  top: HTMLElement | null,
  bottom: HTMLElement | null,
) {
  const upper = top ? top.getBoundingClientRect().bottom : 0;
  const lower = bottom
    ? bottom.getBoundingClientRect().top
    : window.innerHeight;
  const box = element.getBoundingClientRect();
  // A box taller than the space between the bars (a tall textarea) can never be wholly clear: leave the browser's placement.
  if (box.height + 2 * RING > lower - upper) return;
  if (box.top - RING >= upper && box.bottom + RING <= lower) return;
  element.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    behavior: "instant",
  });
}

export function useChromeInsets(
  top: HTMLElement | null,
  bottom: HTMLElement | null,
) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const write = (property: string, bar: HTMLElement | null) => {
      if (bar) root.style.setProperty(property, `${bar.offsetHeight + RING}px`);
      else root.style.removeProperty(property);
    };
    const measure = () => {
      write(TOP, top);
      write(BOTTOM, bottom);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const bar of [top, bottom]) if (bar) observer.observe(bar);
    // Only the routed content scrolls beneath the bars; a dialog is fixed and outside <main>, and a bar is not covered by itself.
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("main"))
        revealIfObscured(target, top, bottom);
    };
    const bars = top || bottom;
    if (bars) document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("focusin", onFocus);
      observer.disconnect();
      root.style.removeProperty(TOP);
      root.style.removeProperty(BOTTOM);
    };
  }, [top, bottom]);
}
