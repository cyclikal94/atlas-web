import { act, cleanup } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createGateDialog,
  GATE_HEADING,
} from "../../src/components/ui/gate-dialog";
import { createProtectedSurface } from "../../src/session/adapters/protected-surface";
import type { ProtectedSurface } from "../../src/session/ports/surface";

/**
 * WEB-14a revision 19, R27 (design assessment C3, I3-I6, Q2/Q3, S4-S9): the protected surface's heading focus is a FALLBACK. It waits for
 * the router's heading in animation frames; a focus that something in the tree has placed (a restored form's first field, an update
 * action, the person) wins over it in EITHER order, and a gate, an unmount, a lift with a saved place or another account's tree ends it.
 * The frames are queued by the test, so each order is forced, not hoped for. The first three cases are the independent reviewer's probe
 * (`.agtx/evidence/review-r18-20261015/focus-order.test.tsx`), promoted with their assertions unchanged. jsdom does not compute `inert`:
 * these cases prove the ORDER of the adapter's decisions; native focus eligibility is the real-engine specs'.
 */
let surface: ProtectedSurface | null = null;
afterEach(() => {
  if (surface) act(() => surface?.unmountTree());
  surface = null;
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

type Tree = (account: string) => React.ReactNode;

const restoredForm: Tree = () => (
  <main>
    <input aria-label="Restored title" />
    <button type="button" data-focus-key="kept">
      Kept
    </button>
  </main>
);

function start(renderTree: Tree = restoredForm, account = "acct-a") {
  document.body.innerHTML =
    '<div id="neutral-root"></div><div id="protected-root" inert aria-hidden="true"></div>';
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((fn) => {
    frames.push(fn);
    return frames.length;
  });
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  const created = createProtectedSurface({
    renderTree,
    gateDialog: createGateDialog(),
    liveRegions: { clearAll() {}, announce() {} },
  });
  surface = created;
  act(() => created.attachTree(account, 1));
  const root = document.getElementById("protected-root") as HTMLElement;
  const heading = document.createElement("h1");
  heading.textContent = "Today";
  return { surface: created, root, heading, frames };
}

/** Runs the frames queued so far (the router's later render is simulated by appending the heading before). */
const runFrames = (frames: FrameRequestCallback[]) =>
  act(() => {
    for (const frame of frames.splice(0)) frame(performance.now());
  });

describe("R27: the delayed heading never overrides focus placed in the tree", () => {
  test("control: delayed heading takes focus when no form has claimed it", () => {
    const { root, heading, frames } = start();
    expect(root.hasAttribute("inert")).toBe(false);
    expect(frames).toHaveLength(1);
    root.append(heading);
    runFrames(frames);
    expect(heading).toHaveFocus();
  });

  test("restored field focus is retained when the delayed route heading arrives", () => {
    const { root, heading, frames } = start();
    const input = root.querySelector("input") as HTMLInputElement;
    input.focus();
    expect(input).toHaveFocus();
    root.append(heading);
    runFrames(frames);
    expect(
      input,
      "A heading retry must not overwrite focus placed by the restored form",
    ).toHaveFocus();
  });

  test("control: an unmounted tree cancels its queued heading focus", () => {
    const { root, heading, frames, surface: created } = start();
    (root.querySelector("input") as HTMLInputElement).focus();
    root.append(heading);
    act(() => created.unmountTree());
    runFrames(frames);
    expect(document.activeElement).toBe(document.body);
  });

  test("the opposite order: the heading arrives and takes focus first, then the restored field takes it and keeps it", () => {
    const { root, heading, frames } = start();
    root.append(heading);
    runFrames(frames);
    expect(heading).toHaveFocus();
    const input = root.querySelector("input") as HTMLInputElement;
    input.focus();
    runFrames(frames);
    expect(frames).toHaveLength(0);
    expect(input).toHaveFocus();
  });

  test("a claim ends the wait even when the claimed control has gone before the heading arrives (no fallback onto it later)", () => {
    const { root, heading, frames } = start();
    const input = root.querySelector("input") as HTMLInputElement;
    input.focus();
    input.remove();
    expect(document.activeElement).toBe(document.body);
    root.append(heading);
    runFrames(frames);
    expect(heading).not.toHaveFocus();
    expect(frames).toHaveLength(0);
  });

  test("focus already placed in the tree before the FIRST attempt (the heading is there too) is kept", () => {
    // A control of the tree focuses itself while the tree mounts (as a restored field whose read was already done would).
    const { root } = start(() => (
      <main>
        <h1>Today</h1>
        <input
          aria-label="Restored title"
          ref={(element) => element?.focus()}
        />
      </main>
    ));
    expect(root.querySelector("input")).toHaveFocus();
  });

  test("control: with nothing focused in the tree, a heading that is already there is focused at once", () => {
    const { root, frames } = start(() => (
      <main>
        <h1>Today</h1>
        <input aria-label="Restored title" />
      </main>
    ));
    expect(root.querySelector("h1")).toHaveFocus();
    expect(frames).toHaveLength(0);
  });
});

describe("R27: a heading focus still pending ends at every change of who owns focus", () => {
  test("the gate closes while it waits: the gate keeps focus when the tree's heading appears", () => {
    const { root, heading, frames, surface: created } = start();
    act(() => created.applyLevel0());
    const gateHeading = document.querySelector(
      `dialog h2, dialog [id$="heading"], dialog h1`,
    ) as HTMLElement | null;
    expect(gateHeading?.textContent).toBe(GATE_HEADING);
    gateHeading?.focus();
    root.append(heading);
    runFrames(frames);
    expect(heading).not.toHaveFocus();
    expect(gateHeading).toHaveFocus();
  });

  test("a lift over the same account restores the saved control; the mount's pending heading does not take it afterwards", () => {
    const { root, heading, frames, surface: created } = start();
    const kept = root.querySelector('[data-focus-key="kept"]') as HTMLElement;
    kept.focus();
    act(() => {
      created.saveFocusAndScroll("acct-a", 1);
      created.applyLevel0();
    });
    act(() => created.attachTree("acct-a", 1));
    expect(kept).toHaveFocus();
    root.append(heading);
    runFrames(frames);
    expect(kept).toHaveFocus();
  });

  test("another account's tree replaces the first while its heading is pending: only the new tree's heading is focused", () => {
    const tree: Tree = (account) => (
      <main data-account={account}>
        <p>{account}</p>
      </main>
    );
    const { root, frames, surface: created } = start(tree);
    act(() => created.attachTree("acct-b", 2));
    const late = document.createElement("h1");
    late.textContent = "Heading of acct-b";
    root.querySelector('[data-account="acct-b"]')?.append(late);
    runFrames(frames);
    expect(late).toHaveFocus();
    expect(root.querySelector('[data-account="acct-a"]')).toBeNull();
  });

  test("StrictMode-style double effects in the tree that focus a field leave it focused (no second fallback)", () => {
    function Field() {
      useEffect(() => {
        (
          document.querySelector('[aria-label="Field"]') as HTMLElement | null
        )?.focus();
      }, []);
      return <input aria-label="Field" />;
    }
    const { root, heading, frames } = start(() => (
      <main>
        <Field />
      </main>
    ));
    root.append(heading);
    runFrames(frames);
    expect(root.querySelector('[aria-label="Field"]')).toHaveFocus();
  });
});
