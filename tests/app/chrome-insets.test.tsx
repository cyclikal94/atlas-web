import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProtectedProviders } from "../../src/app/providers";
import { AppShell } from "../../src/app/shell/AppShell";
import { useChromeInsets } from "../../src/app/shell/chrome-insets";
import { installMatchMedia } from "../helpers/match-media";

/**
 * The sticky mobile bars cover part of the viewport, so the root's scroll-padding is fed from their measured heights
 * (src/app/shell/chrome-insets.ts, src/styles/base.css). jsdom has no layout, so heights are supplied and the observer is a spy;
 * the real browsers are covered by tests/e2e/fixture.scroll.spec.ts.
 */
const TOP = "--shell-inset-top";
const BOTTOM = "--shell-inset-bottom";
const RING = 4;
const root = () => document.documentElement;
const inset = (name: string) => root().style.getPropertyValue(name);

const heights = new Map<string, number>();
let resize: Array<() => void> = [];
let observed: Element[] = [];
const originalObserver = globalThis.ResizeObserver;
const originalHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight",
);

beforeEach(() => {
  heights.clear();
  resize = [];
  observed = [];
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resize.push(callback);
    }
    observe(element: Element) {
      observed.push(element);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return heights.get(this.dataset.bar ?? "") ?? 0;
    },
  });
});
afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalObserver;
  if (originalHeight)
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      originalHeight,
    );
  root().style.removeProperty(TOP);
  root().style.removeProperty(BOTTOM);
});

function Bars({ bottom }: { bottom: boolean }) {
  const [top, setTop] = useState<HTMLElement | null>(null);
  const [tabs, setTabs] = useState<HTMLElement | null>(null);
  useChromeInsets(top, tabs);
  return (
    <>
      <header ref={setTop} data-bar="top" />
      {bottom ? <nav ref={setTabs} data-bar="bottom" /> : null}
    </>
  );
}

describe("useChromeInsets", () => {
  test("publishes each bar's height plus room for the focus ring", () => {
    heights.set("top", 61);
    heights.set("bottom", 65);
    render(<Bars bottom />);
    expect(inset(TOP)).toBe(`${61 + RING}px`);
    expect(inset(BOTTOM)).toBe(`${65 + RING}px`);
    expect(observed.map((element) => element.getAttribute("data-bar"))).toEqual(
      ["top", "bottom"],
    );
  });

  test("follows a bar that grows, as when the status label wraps", () => {
    heights.set("top", 61);
    heights.set("bottom", 65);
    render(<Bars bottom />);
    heights.set("top", 97);
    act(() => {
      for (const callback of resize) callback();
    });
    expect(inset(TOP)).toBe(`${97 + RING}px`);
    expect(inset(BOTTOM)).toBe(`${65 + RING}px`);
  });

  test("a bar that is not rendered contributes nothing, and appears when it is", () => {
    heights.set("top", 61);
    heights.set("bottom", 65);
    const view = render(<Bars bottom={false} />);
    expect(inset(TOP)).toBe(`${61 + RING}px`);
    expect(inset(BOTTOM)).toBe("");
    view.rerender(<Bars bottom />);
    expect(inset(BOTTOM)).toBe(`${65 + RING}px`);
    view.rerender(<Bars bottom={false} />);
    expect(inset(BOTTOM)).toBe("");
  });

  test("removes both on unmount, so a layout without sticky bars adds no padding", () => {
    heights.set("top", 61);
    heights.set("bottom", 65);
    const view = render(<Bars bottom />);
    view.unmount();
    expect(inset(TOP)).toBe("");
    expect(inset(BOTTOM)).toBe("");
  });
});

/**
 * WebKit reveals a focused text field's caret rectangle, not the field, and applies the root's scroll-padding to that: the
 * caret is clear of a bar while the rest of the 44px field and its ring can still be behind it. The shell therefore reveals the
 * whole box of a focus that lands in <main> when a bar overlaps it (the rendered WebKit cases are in fixture.scroll.spec.ts).
 * jsdom has no layout, so the geometry is supplied.
 */
describe("focus reveal beneath the sticky bars", () => {
  const VIEWPORT = 568;
  const HEADER = { top: 0, bottom: 77 };
  const TABS = { top: 503, bottom: 568 };
  const reveal = vi.fn();

  const rect = (top: number, bottom: number) =>
    ({
      top,
      bottom,
      left: 0,
      right: 100,
      x: 0,
      y: top,
      width: 100,
      height: bottom - top,
      toJSON() {},
    }) as DOMRect;
  const place = (element: Element, top: number, bottom: number) => {
    element.getBoundingClientRect = () => rect(top, bottom);
  };

  function Page({ bars = "both" }: { bars?: "both" | "top" | "none" }) {
    const [top, setTop] = useState<HTMLElement | null>(null);
    const [tabs, setTabs] = useState<HTMLElement | null>(null);
    useChromeInsets(
      bars === "none" ? null : top,
      bars === "both" ? tabs : null,
    );
    return (
      <>
        <header ref={setTop} data-bar="top">
          <button type="button">Sync</button>
        </header>
        <main>
          <input aria-label="Field" />
        </main>
        <nav ref={setTabs} data-bar="bottom" />
        <div role="dialog" aria-label="Sheet">
          <input aria-label="In the sheet" />
        </div>
      </>
    );
  }

  function mount(bars: "both" | "top" | "none" = "both") {
    heights.set("top", HEADER.bottom - HEADER.top);
    heights.set("bottom", TABS.bottom - TABS.top);
    const view = render(<Page bars={bars} />);
    place(screen.getByRole("banner"), HEADER.top, HEADER.bottom);
    place(screen.getByRole("navigation"), TABS.top, TABS.bottom);
    return { view, field: screen.getByLabelText("Field") };
  }
  const focusAt = (element: HTMLElement, top: number, bottom: number) => {
    place(element, top, bottom);
    act(() => element.focus());
  };

  beforeEach(() => {
    reveal.mockReset();
    Element.prototype.scrollIntoView = reveal;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: VIEWPORT,
    });
  });

  test("a field under the bottom tabs is revealed as a whole box, nearest edge, without animation", () => {
    const { field } = mount();
    // The reviewed WebKit position: the 44px field ends 9px below the top of the tabs.
    focusAt(field, 468.4, 512.4);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal.mock.instances[0]).toBe(field);
    expect(reveal).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
  });

  test("a field under the header is revealed", () => {
    const { field } = mount();
    focusAt(field, 69.4, 113.4);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  test("a field whose ring is clear of both bars is left alone", () => {
    const { field } = mount();
    // 4px ring: the field may sit exactly 4px from each bar.
    focusAt(field, HEADER.bottom + 4, TABS.top - 4);
    expect(reveal).not.toHaveBeenCalled();
    field.blur();
    focusAt(field, 200, 244);
    expect(reveal).not.toHaveBeenCalled();
  });

  test("the whole ring counts: a field 1px short of ring clearance is revealed, at either bar", () => {
    const { field } = mount();
    focusAt(field, 100, TABS.top - 4 + 1);
    expect(reveal).toHaveBeenCalledTimes(1);
    field.blur();
    focusAt(field, HEADER.bottom + 4 - 1, 200);
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  test("a focus outside <main> is not moved, even where it overlaps a bar (a dialog is fixed; the bars are not covered by themselves)", () => {
    mount();
    focusAt(screen.getByLabelText("In the sheet"), 480, 524);
    focusAt(screen.getByRole("button", { name: "Sync" }), 10, 50);
    expect(reveal).not.toHaveBeenCalled();
  });

  test("a box taller than the space between the bars is left to the browser", () => {
    const { field } = mount();
    focusAt(field, 60, 520);
    expect(reveal).not.toHaveBeenCalled();
  });

  test("a screen with only the header (a detail screen) measures the viewport as the lower edge", () => {
    const { field } = mount("top");
    focusAt(field, 500, 544);
    expect(reveal).not.toHaveBeenCalled();
    field.blur();
    focusAt(field, 540, 584);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  test("with no sticky bars (tablet and desktop) nothing is listening", () => {
    const { field } = mount("none");
    focusAt(field, 468.4, 512.4);
    expect(reveal).not.toHaveBeenCalled();
  });

  test("the listener is removed on unmount", () => {
    const { view, field } = mount();
    view.unmount();
    field.focus();
    expect(reveal).not.toHaveBeenCalled();
  });
});

describe("AppShell", () => {
  const media = installMatchMedia({ width: 390 });

  async function mount(mobileBack?: { label: string; to: string }) {
    const rootRoute = createRootRoute({
      component: () => (
        <AppShell
          syncModel={{ phase: "synced", pendingCount: 0, conflictCount: 0 }}
          onOpenSync={() => {}}
          mobileBack={mobileBack}
        >
          <h1 data-page-heading="">Page</h1>
        </AppShell>
      ),
    });
    const index = createRoute({ getParentRoute: () => rootRoute, path: "/" });
    const router = createRouter({
      routeTree: rootRoute.addChildren([index]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <ProtectedProviders>
        <RouterProvider router={router} />
      </ProtectedProviders>,
    );
    await screen.findByRole("main");
  }

  test("mobile: the header and the bottom tabs are sticky and both are measured", async () => {
    await mount();
    expect(screen.getByRole("banner")).toHaveClass(
      "sticky",
      "top-0",
      "bg-background",
    );
    expect(screen.getByRole("navigation", { name: "Primary" })).toHaveClass(
      "sticky",
      "bottom-0",
      "bg-sidebar",
    );
    expect(inset(TOP)).toBe(`${RING}px`);
    expect(inset(BOTTOM)).toBe(`${RING}px`);
  });

  test("a detail screen has no tab bar, so only the header is measured", async () => {
    await mount({ label: "Back", to: "/" });
    expect(screen.getByRole("banner")).toHaveClass("sticky", "top-0");
    expect(inset(TOP)).toBe(`${RING}px`);
    expect(inset(BOTTOM)).toBe("");
  });

  test("desktop: the rail is sticky and one viewport tall, and there is nothing to measure", async () => {
    media.set({ width: 1440 });
    await mount();
    const rail = screen.getByRole("region", { name: "Workspace" });
    expect(rail).toHaveClass("sticky", "top-0", "h-dvh", "self-start");
    // Its navigation scrolls inside it when the window is short; the status footer below does not.
    expect(screen.getByRole("navigation", { name: "Primary" })).toHaveClass(
      "overflow-y-auto",
      "min-h-0",
      "flex-1",
    );
    expect(inset(TOP)).toBe("");
    expect(inset(BOTTOM)).toBe("");
  });

  test("leaving mobile for desktop clears the insets", async () => {
    await mount();
    expect(inset(TOP)).not.toBe("");
    act(() => media.set({ width: 1440 }));
    expect(inset(TOP)).toBe("");
    expect(inset(BOTTOM)).toBe("");
  });
});
