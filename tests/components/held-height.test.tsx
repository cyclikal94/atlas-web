// WEB-13b revision 36 (Review 43 F43-1; design assessment 4062d86c DA-1, Q1-Q3): the `HeldHeight` primitive keeps the height its content
// had at the RISING EDGE of `held`, read before React changes the page, and releases it at the falling edge.
//
// jsdom lays nothing out, so the wrapper's height is stubbed from the DOM it holds AT THE MOMENT IT IS ASKED: 40 px per `[data-row]` inside
// it. A read made after the commit's DOM changes therefore sees the collapsed rows and differs from a read made before them, and a read
// made at an earlier render misses rows the content added by itself since. Each case records the wrapper's `min-height` from a layout
// effect of a sibling that runs in the same commit, so "applied in the first held commit" is observed, not assumed.
import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HeldHeight } from "../../src/components/ui/held-height";

const ROW = 40;
let restore: () => void = () => undefined;

beforeEach(() => {
  const original = HTMLElement.prototype.getBoundingClientRect;
  const spy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (!this.hasAttribute("data-held-height")) return original.call(this);
      const height = this.querySelectorAll("[data-row]").length * ROW;
      return new DOMRect(0, 0, 100, height);
    });
  restore = () => spy.mockRestore();
});

afterEach(() => {
  restore();
  cleanup();
});

/** The wrapper's inline `min-height` in every commit, recorded by a layout effect that runs in that same commit. */
function Witness({
  log,
  tag,
}: {
  log: Array<{ tag: string; minHeight: string }>;
  tag: string;
}) {
  useLayoutEffect(() => {
    const box = document.querySelector<HTMLElement>("[data-held-height]");
    log.push({ tag, minHeight: box?.style.minHeight ?? "(none)" });
  });
  return null;
}

/** Content that drops rows while `blocked`, the way the audience chooser drops its editing controls. */
function Collapsing({
  blocked,
  rows,
  extra,
}: {
  blocked: boolean;
  rows: number;
  extra?: ReactNode;
}) {
  return (
    <div>
      <p data-row="">summary</p>
      {blocked
        ? null
        : Array.from({ length: rows }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed rows of a test double
            <button key={i} type="button" data-row="">
              control {i}
            </button>
          ))}
      {extra}
    </div>
  );
}

function Scene({
  held,
  rows = 4,
  tag,
  log,
  extra,
}: {
  held: boolean;
  rows?: number;
  tag: string;
  log: Array<{ tag: string; minHeight: string }>;
  extra?: ReactNode;
}) {
  return (
    <>
      <HeldHeight held={held}>
        <Collapsing blocked={held} rows={rows} extra={extra} />
      </HeldHeight>
      <Witness log={log} tag={tag} />
    </>
  );
}

const box = () => {
  const element = document.querySelector<HTMLElement>("[data-held-height]");
  expect(element).not.toBeNull();
  return element as HTMLElement;
};

describe("HeldHeight (WEB-13b revision 36, F43-1 / DA-1)", () => {
  test("Q1: the rising edge reserves the height read BEFORE the update, and the first held commit already carries it", () => {
    const log: Array<{ tag: string; minHeight: string }> = [];
    const view = render(<Scene held={false} tag="editable" log={log} />);
    // 1 summary + 4 controls = 200 px while editable; once held only the summary is left (40 px).
    expect(box().getBoundingClientRect().height).toBe(5 * ROW);
    view.rerender(<Scene held tag="held" log={log} />);
    expect(box().querySelectorAll("button")).toHaveLength(0);
    expect(log.find((entry) => entry.tag === "held")).toEqual({
      tag: "held",
      minHeight: `${5 * ROW}px`,
    });
    expect(box().style.minHeight).toBe(`${5 * ROW}px`);
    // Nothing else is written on the wrapper: no content, role or name is added.
    expect(box().getAttributeNames().sort()).toEqual([
      "data-held-height",
      "style",
    ]);
    expect(box().textContent).toBe("summary");
  });

  test("Q2: a height the content reached ON ITS OWN (no parent render since) is the one reserved at the edge", () => {
    const log: Array<{ tag: string; minHeight: string }> = [];
    let grow: () => void = () => undefined;
    /** Rows the content adds itself (a household picker opened, a membership read answered), with no render of the parent. */
    function Own({ blocked }: { blocked: boolean }) {
      const [more, setMore] = useState(0);
      grow = () => setMore((n) => n + 1);
      return blocked
        ? null
        : Array.from({ length: more }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed rows of a test double
            <span key={i} data-row="">
              own {i}
            </span>
          ));
    }
    let parentRenders = 0;
    function Parent({ held }: { held: boolean }) {
      parentRenders += 1;
      return (
        <Scene
          held={held}
          tag={held ? "held" : "editable"}
          log={log}
          extra={<Own blocked={held} />}
        />
      );
    }
    const view = render(<Parent held={false} />);
    const before = parentRenders;
    act(() => grow());
    act(() => grow());
    expect(parentRenders).toBe(before);
    expect(box().getBoundingClientRect().height).toBe(7 * ROW);
    view.rerender(<Parent held />);
    expect(log.find((entry) => entry.tag === "held")?.minHeight).toBe(
      `${7 * ROW}px`,
    );
  });

  test("Q3a: the falling edge releases the reserve, in the commit that brings the content back", () => {
    const log: Array<{ tag: string; minHeight: string }> = [];
    const view = render(<Scene held={false} tag="editable" log={log} />);
    view.rerender(<Scene held tag="held" log={log} />);
    expect(box().style.minHeight).toBe(`${5 * ROW}px`);
    view.rerender(<Scene held={false} tag="released" log={log} />);
    expect(box().style.minHeight).toBe("");
    expect(box().querySelectorAll("button")).toHaveLength(4);
    // The sibling's layout effect runs after the wrapper's `componentDidUpdate`: the released commit carries no reserve.
    expect(log.filter((entry) => entry.tag === "released")).toEqual([
      { tag: "released", minHeight: "" },
    ]);
  });

  test("Q3b: content that mounts already held reserves nothing (nothing collapsed under a pointer)", () => {
    const log: Array<{ tag: string; minHeight: string }> = [];
    const view = render(<Scene held tag="mounted-held" log={log} />);
    expect(box().style.minHeight).toBe("");
    view.rerender(<Scene held tag="still-held" log={log} />);
    expect(box().style.minHeight).toBe("");
    expect(log.map((entry) => entry.minHeight)).toEqual(["", ""]);
  });

  test("Q3c: staying held keeps the FIRST height, whatever the content does meanwhile (sending, then confirming)", () => {
    const log: Array<{ tag: string; minHeight: string }> = [];
    const view = render(<Scene held={false} tag="editable" log={log} />);
    view.rerender(<Scene held tag="sending" log={log} />);
    view.rerender(<Scene held rows={9} tag="confirming" log={log} />);
    expect(box().style.minHeight).toBe(`${5 * ROW}px`);
    expect(log.filter((entry) => entry.tag !== "editable")).toEqual([
      { tag: "sending", minHeight: `${5 * ROW}px` },
      { tag: "confirming", minHeight: `${5 * ROW}px` },
    ]);
  });

  test("Q3d: a height of 0 at the edge reserves nothing", () => {
    const log: Array<{ tag: string; minHeight: string }> = [];
    function Empty({ held }: { held: boolean }) {
      return (
        <>
          <HeldHeight held={held}>{null}</HeldHeight>
          <Witness log={log} tag={held ? "held" : "editable"} />
        </>
      );
    }
    const view = render(<Empty held={false} />);
    view.rerender(<Empty held />);
    expect(box().style.minHeight).toBe("");
    expect(box().hasAttribute("style")).toBe(false);
  });

  test("Q3e: a second rising edge reserves the height of ITS moment, not the first one's", () => {
    const log: Array<{ tag: string; minHeight: string }> = [];
    const view = render(<Scene held={false} tag="editable" log={log} />);
    view.rerender(<Scene held tag="held-1" log={log} />);
    view.rerender(<Scene held={false} rows={2} tag="editable-2" log={log} />);
    view.rerender(<Scene held rows={2} tag="held-2" log={log} />);
    expect(log.find((entry) => entry.tag === "held-2")?.minHeight).toBe(
      `${3 * ROW}px`,
    );
  });
});
