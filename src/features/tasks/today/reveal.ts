import { useEffect, useRef } from "react";

/** How far the reader scrolls on past the end of the day (wheel or touch) before the days ahead are revealed: a notch or two. */
export const REVEAL_DISTANCE = 48;
const REVEAL_IDLE_MS = 400;

/**
 * The days ahead are revealed by scrolling on past the end of the day (the Final design, revised 8 November 2026): once the page is
 * at its end, a further wheel or touch pull of `REVEAL_DISTANCE` opens the fold (`onReveal`), at once and without ceremony. A pause
 * or a pull back lets the distance go. Nothing of this while the fold is open (`enabled` false) and nothing before the end of the page:
 * an ordinary scroll stays an ordinary scroll.
 */
export function usePullToReveal(enabled: boolean, onReveal: () => void): void {
  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  useEffect(() => {
    if (!enabled) return;
    let pulled = 0;
    let timer = 0;
    let touchY: number | null = null;
    const atEnd = () =>
      window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 2;
    const release = () => {
      window.clearTimeout(timer);
      timer = 0;
      pulled = 0;
    };
    const pull = (delta: number) => {
      if (delta <= 0 || !atEnd()) {
        if (pulled !== 0) release();
        return;
      }
      window.clearTimeout(timer);
      pulled += delta;
      if (pulled >= REVEAL_DISTANCE) {
        release();
        reveal.current();
        return;
      }
      timer = window.setTimeout(release, REVEAL_IDLE_MS);
    };
    const onWheel = (event: WheelEvent) =>
      pull(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY);
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined || touchY === null) return;
      pull(touchY - y);
      touchY = y;
    };
    const onTouchEnd = () => {
      touchY = null;
      if (pulled !== 0) release();
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled]);
}
