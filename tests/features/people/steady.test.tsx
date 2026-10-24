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

/**
 * Review 7, finding 3: a fixed outer height does not keep a pressed action under the pointer when what is laid out before it INSIDE the
 * box changes. The pressed action itself keeps its place (translated back after each change inside the root) and its size, until the
 * press ends; a removed or disabled action is let go at once. Geometry is given (jsdom has no layout); native E-P34/E-P35 are the
 * engines' own.
 */
describe("review 7, finding 3: the pressed action keeps its place and size", () => {
  function Row({
    answered,
    disabled,
  }: {
    answered: boolean;
    disabled: boolean;
  }) {
    const root = useRef<HTMLDivElement>(null);
    useSteadyWhilePressed(root);
    return (
      <div ref={root}>
        <div data-steady="" data-testid="row">
          {answered ? <span data-testid="reach">reach</span> : null}
          <button
            type="button"
            data-testid="edit"
            disabled={disabled}
            style={{ transform: "rotate(0deg)" }}
          >
            <span data-testid="label">Edit</span>
          </button>
        </div>
      </div>
    );
  }
  /** Laid-out tops by test id (what the engine would say), before any translation of ours. */
  function geometry(tops: Map<string, number>) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const id = this.dataset.testid ?? "";
        const top = tops.get(id) ?? 0;
        // Our own translation moves what is measured, as it does in an engine.
        const moved = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
          this.style.transform,
        );
        const dy = moved ? Number(moved[2]) : 0;
        const height = id === "row" ? 174 : id === "edit" ? 44 : 10;
        return {
          top: top + dy,
          left: 30,
          width: id === "edit" ? 57 : 300,
          height,
          bottom: top + dy + height,
          right: 330,
          x: 30,
          y: top + dy,
        } as DOMRect;
      },
    );
  }
  const flush = () => act(async () => undefined);

  for (const [name, after] of [
    ["grows (the reach arrives above it)", 541],
    ["shrinks (a line above it goes)", 497],
  ] as const)
    test(`what is above the action ${name}: it is translated back while pressed, and everything is restored after the click`, async () => {
      const tops = new Map([["edit", 519]]);
      geometry(tops);
      const view = render(<Row answered={false} disabled={false} />);
      const edit = view.getByTestId("edit");
      fireEvent.pointerDown(view.getByTestId("label"));
      expect(edit.style.width).toBe("57px");
      expect(edit.style.height).toBe("44px");
      tops.set("edit", after);
      view.rerender(<Row answered disabled={false} />);
      await flush();
      expect(edit.style.transform).toBe(`translate(0px, ${519 - after}px)`);
      expect(edit.getBoundingClientRect().top).toBe(519);
      fireEvent.pointerUp(edit);
      fireEvent.click(edit);
      expect(edit.style.transform).toBe("rotate(0deg)");
      expect(edit.style.width).toBe("");
      expect(edit.style.height).toBe("");
      expect(view.getByTestId("row").style.height).toBe("");
    });

  test("an action disabled while pressed is let go at once (never kept for a click)", async () => {
    const tops = new Map([["edit", 519]]);
    geometry(tops);
    const view = render(<Row answered={false} disabled={false} />);
    const edit = view.getByTestId("edit");
    fireEvent.pointerDown(edit);
    expect(edit.style.width).toBe("57px");
    tops.set("edit", 541);
    view.rerender(<Row answered disabled />);
    await flush();
    expect(edit.style.transform).toBe("rotate(0deg)");
    expect(edit.style.width).toBe("");
    expect(view.getByTestId("row").style.height).toBe("");
  });

  test("a second pointer does not start another press; the first one's release still ends it", () => {
    geometry(new Map([["edit", 519]]));
    vi.useFakeTimers();
    const view = render(<Row answered={false} disabled={false} />);
    const edit = view.getByTestId("edit");
    fireEvent.pointerDown(edit, { pointerId: 1 });
    fireEvent.pointerDown(document.body, { pointerId: 2 });
    expect(edit.style.width).toBe("57px");
    fireEvent.pointerUp(document.body, { pointerId: 2 });
    act(() => vi.advanceTimersByTime(600));
    expect(edit.style.width).toBe("57px");
    fireEvent.pointerUp(edit, { pointerId: 1 });
    act(() => vi.advanceTimersByTime(500));
    expect(edit.style.width).toBe("");
  });

  test("the page being hidden ends the press", () => {
    geometry(new Map([["edit", 519]]));
    const view = render(<Row answered={false} disabled={false} />);
    const edit = view.getByTestId("edit");
    fireEvent.pointerDown(edit);
    expect(edit.style.width).toBe("57px");
    fireEvent(window, new Event("pagehide"));
    expect(edit.style.width).toBe("");
  });

  test("a press outside any action holds no action (only the boxes)", () => {
    geometry(new Map([["edit", 519]]));
    const view = render(<Row answered={false} disabled={false} />);
    fireEvent.pointerDown(view.getByTestId("row"));
    expect(view.getByTestId("row").style.height).toBe("174px");
    expect(view.getByTestId("edit").style.width).toBe("");
  });
});
