import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useSteadyWhilePressed } from "../../../src/features/people/detail/steady";

/**
 * Review 6, finding 3 (`people-linkage-layout-pointer-loss`): while a press is in progress, the person detail's `[data-steady]` boxes
 * keep the height they had when it began, and take their own height again when it ends (its click delivered, the press cancelled, or a
 * pointer released elsewhere). jsdom has no layout, so heights are given; the real engines' geometry is native E-P33.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function Detail({ onAct }: { onAct(): void }) {
  const root = useRef<HTMLDivElement>(null);
  useSteadyWhilePressed(root);
  return (
    <div ref={root}>
      <div data-steady="" data-testid="head">
        head
      </div>
      <div data-steady="" data-testid="rows">
        rows
      </div>
      <div data-testid="plain">plain</div>
      <button type="button" onClick={onAct}>
        Add a field
      </button>
    </div>
  );
}

function mounted() {
  const acted: number[] = [];
  const view = render(<Detail onAct={() => acted.push(1)} />);
  const heights = new Map([
    ["head", 120],
    ["rows", 48],
    ["plain", 10],
  ]);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const height = heights.get(this.dataset.testid ?? "") ?? 0;
      return { height, width: 0, top: 0, left: 0 } as DOMRect;
    },
  );
  const box = (id: string) => view.getByTestId(id);
  const button = view.getByRole("button", { name: "Add a field" });
  return { acted, box, button };
}

describe("review 6, finding 3: boxes stay steady while a press is in progress", () => {
  test("a press fixes every steady box at its height (and nothing else); the click reaches its target, then they are released", () => {
    const { acted, box, button } = mounted();
    fireEvent.pointerDown(button);
    expect(box("head").style.height).toBe("120px");
    expect(box("rows").style.height).toBe("48px");
    expect(box("plain").style.height).toBe("");
    fireEvent.pointerUp(button);
    expect(box("head").style.height).toBe("120px");
    fireEvent.click(button);
    expect(acted).toEqual([1]);
    expect(box("head").style.height).toBe("");
    expect(box("rows").style.height).toBe("");
  });

  test("a cancelled press releases them at once", () => {
    const { box, button } = mounted();
    fireEvent.pointerDown(button);
    expect(box("head").style.height).toBe("120px");
    fireEvent.pointerCancel(button);
    expect(box("head").style.height).toBe("");
  });

  test("a pointer released elsewhere (no click) releases them after RELEASE_MS, not before", () => {
    vi.useFakeTimers();
    const { box, button } = mounted();
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(document.body);
    act(() => vi.advanceTimersByTime(499));
    expect(box("head").style.height).toBe("120px");
    act(() => vi.advanceTimersByTime(1));
    expect(box("head").style.height).toBe("");
  });

  test("a second press measures afresh after a release, and unmounting releases a held press", () => {
    const { box, button } = mounted();
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    fireEvent.pointerDown(button);
    expect(box("head").style.height).toBe("120px");
    const head = box("head");
    cleanup();
    expect(head.style.height).toBe("");
  });

  test("a keyboard activation fixes nothing", () => {
    const { acted, box, button } = mounted();
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(acted).toEqual([1]);
    expect(box("head").style.height).toBe("");
  });
});
