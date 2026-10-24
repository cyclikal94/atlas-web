import { type RefObject, useEffect } from "react";

/** How long boxes stay fixed after a pointer came up without a click (a click releases them at once). */
const RELEASE_MS = 500;

/** What a press can activate: the element whose place under the pointer is kept while it is pressed. */
const ACTION =
  "a[href], button, [role='button'], summary, label, input, select, textarea";

/** The pressed action, where it was when the press began (page coordinates) and what its own inline styles were. */
interface Held {
  element: HTMLElement;
  left: number;
  top: number;
  /** The translation applied now to keep it there. */
  dx: number;
  dy: number;
  style: { transform: string; width: string; height: string };
}

/**
 * A press is never lost to a read that answers during it (review 6, finding 3; review 7, finding 3). The person's linkage, a conflict,
 * the outstanding-change notice or a field's audience and reach can answer between a pointer going down on an enabled action ("Add a
 * field", Edit, Archive, a row…) and coming up; whatever is laid out before the action would then move it from under the pointer and the
 * press would activate nothing. So while a pointer is down anywhere in the page:
 *  - every `[data-steady]` box inside `root` keeps the height it had when the press began (nothing below it moves);
 *  - and the PRESSED action itself (the actionable element under the pointer, inside `root`) keeps its place and size on the page: when
 *    anything inside `root` changes, it is measured again and translated back to where it was (a fixed outer box is not enough: a
 *    narrow field row stacks its audience and reach above Edit and Archive, which then move INSIDE the row). A translated action is
 *    painted, and hit, above what moved under it, so the release lands on it and nothing else.
 * What is shown changes at once (a taller answer overflows for that moment); nothing is held back. Everything takes its own place again
 * when the press ends: once its click has been delivered (after the target's own handlers), at once when the press is cancelled, the
 * page is hidden or the pressed action is removed or disabled (a withdrawn action is never kept for a click), or `RELEASE_MS` after the
 * pointer came up without a click (it was released somewhere else). A second pointer does not start another press. A keyboard
 * activation does not depend on where anything is, and is not affected.
 */
/** The pointer of an event (an engine without pointer ids has one pointer). */
const idOf = (event: PointerEvent): number =>
  typeof event.pointerId === "number" ? event.pointerId : 0;

export function useSteadyWhilePressed(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let boxes: HTMLElement[] = [];
    let held: Held | null = null;
    let pointer: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let observer: MutationObserver | null = null;

    const release = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      observer?.disconnect();
      observer = null;
      window.removeEventListener("resize", follow);
      for (const box of boxes) box.style.height = "";
      boxes = [];
      if (held !== null) {
        const { element, style } = held;
        element.style.transform = style.transform;
        element.style.width = style.width;
        element.style.height = style.height;
      }
      held = null;
      pointer = null;
    };

    /** Keeps the pressed action where it was: measured as laid out now, translated by the difference. */
    function follow() {
      if (held === null) return;
      const { element } = held;
      if (
        !element.isConnected ||
        element.matches(":disabled, [aria-disabled='true']")
      ) {
        release();
        return;
      }
      const rect = element.getBoundingClientRect();
      const left = rect.left + window.scrollX - held.dx;
      const top = rect.top + window.scrollY - held.dy;
      const dx = held.left - left;
      const dy = held.top - top;
      if (dx === held.dx && dy === held.dy) return;
      held.dx = dx;
      held.dy = dy;
      element.style.transform =
        dx === 0 && dy === 0
          ? held.style.transform
          : `translate(${dx}px, ${dy}px)`;
    }

    const ours = (record: MutationRecord) =>
      record.type === "attributes" &&
      record.attributeName === "style" &&
      (record.target === held?.element ||
        boxes.includes(record.target as HTMLElement));

    const down = (event: PointerEvent) => {
      if (timer !== null) release();
      const container = root.current;
      if (pointer !== null || container === null) return;
      pointer = idOf(event);
      const found = [
        ...container.querySelectorAll<HTMLElement>("[data-steady]"),
      ];
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(ACTION)
          : null;
      const action =
        target !== null &&
        container.contains(target) &&
        !target.matches(":disabled, [aria-disabled='true']")
          ? target
          : null;
      // Measured first, then fixed: fixing one box never changes another's measured height.
      const heights = found.map((box) => box.getBoundingClientRect().height);
      const rect = action?.getBoundingClientRect() ?? null;
      found.forEach((box, index) => {
        box.style.height = `${heights[index]}px`;
      });
      boxes = found;
      if (
        action !== null &&
        rect !== null &&
        rect.width > 0 &&
        rect.height > 0
      ) {
        held = {
          element: action,
          left: rect.left + window.scrollX,
          top: rect.top + window.scrollY,
          dx: 0,
          dy: 0,
          style: {
            transform: action.style.transform,
            width: action.style.width,
            height: action.style.height,
          },
        };
        action.style.width = `${rect.width}px`;
        action.style.height = `${rect.height}px`;
        // Whatever changes inside the root moves the action at most until it is measured again, before the next input is hit-tested.
        observer = new MutationObserver((records) => {
          if (records.some((record) => !ours(record))) follow();
        });
        observer.observe(container, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
        window.addEventListener("resize", follow);
        follow();
      }
    };
    const up = (event: PointerEvent) => {
      if (pointer === null || idOf(event) !== pointer) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(release, RELEASE_MS);
    };
    const cancel = (event: PointerEvent) => {
      if (pointer !== null && idOf(event) === pointer) release();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") release();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    // Bubbling: the click has reached its target (and its handlers ran) before anything moves.
    document.addEventListener("click", release);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", release);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("click", release);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [root]);
}
