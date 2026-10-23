import { type RefObject, useEffect } from "react";

/** How long boxes stay fixed after a pointer came up without a click (a click releases them at once). */
const RELEASE_MS = 500;

/**
 * A press is never lost to a read that answers during it (review 6, finding 3). The person's linkage, a conflict, the outstanding-change
 * notice or a field's audience can answer between a pointer going down on an enabled action ("Add a field", Edit, Archive…) and coming
 * up; the boxes above the action would then change height, the action would move from under the pointer and the press would activate
 * nothing. So while a pointer is down anywhere in the page, every `[data-steady]` box inside `root` keeps the height it had when the press
 * began: what it shows changes at once (a taller answer overflows its box for that moment), but nothing below it moves. The boxes take
 * their own height again when the press ends: once its click has been delivered (after the target's own handlers), at once when the press
 * is cancelled, or `RELEASE_MS` after the pointer came up without a click (it was released somewhere else). A keyboard activation does
 * not depend on where anything is, and is not affected.
 */
export function useSteadyWhilePressed(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let held: HTMLElement[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const release = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const box of held) box.style.height = "";
      held = [];
    };
    const down = () => {
      if (timer !== null) release();
      if (held.length > 0 || root.current === null) return;
      const boxes = [
        ...root.current.querySelectorAll<HTMLElement>("[data-steady]"),
      ];
      // Measured first, then fixed: fixing one box never changes another's measured height.
      const heights = boxes.map((box) => box.getBoundingClientRect().height);
      boxes.forEach((box, index) => {
        box.style.height = `${heights[index]}px`;
      });
      held = boxes;
    };
    const up = () => {
      if (held.length === 0) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(release, RELEASE_MS);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", release, true);
    // Bubbling: the click has reached its target (and its handlers ran) before the boxes move.
    document.addEventListener("click", release);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", release, true);
      document.removeEventListener("click", release);
      release();
    };
  }, [root]);
}
