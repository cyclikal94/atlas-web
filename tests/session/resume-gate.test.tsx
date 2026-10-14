import { act, cleanup, fireEvent } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createGateDialog,
  GATE_HEADING,
  GATE_ID,
} from "../../src/components/ui/gate-dialog";
import { isGated } from "../../src/protected-surface/gate";
import { setProtectedTitle } from "../../src/protected-surface/title";
import {
  createProtectedSurface,
  DIFFERENT_ACCOUNT_MESSAGE,
} from "../../src/session/adapters/protected-surface";
import type { ProtectedSurface } from "../../src/session/ports/surface";

/**
 * F-GATE: the DOM contract of the level-0 resume gate and the exposure (matrix 3.7.2), in jsdom, through the production
 * `ProtectedSurface` adapter. jsdom has no top layer and does not compute `inert`, so what is asserted here is the attribute
 * and DOM contract; the real `inert`, the real top layer and Tab order are the real-engine specs (S-GATE).
 */
function setUp() {
  document.body.innerHTML = `
    <div id="neutral-root"></div>
    <div id="protected-root" inert aria-hidden="true"></div>`;
  document.title = "Atlas";
  const live = { clearAll: vi.fn(), announce: vi.fn() };
  const calls: string[] = [];
  const surface = createProtectedSurface({
    renderTree: (account) => (
      <main>
        <h1>{`Heading of ${account}`}</h1>
        <button type="button" data-focus-key="rename">
          Rename
        </button>
        <button type="button" data-focus-key="other">
          Other
        </button>
      </main>
    ),
    gateDialog: {
      ...createGateDialog(),
      open() {
        calls.push("dialog.open");
        gate.open();
        gate.focusHeading();
      },
      close() {
        calls.push("dialog.close");
        gate.close();
      },
      focusHeading() {},
    },
    liveRegions: live,
  });
  const gate = createGateDialog();
  return { surface, live, gate, calls };
}

let ctx: ReturnType<typeof setUp>;
const root = () => document.getElementById("protected-root") as HTMLElement;
const dialog = () =>
  document.getElementById(GATE_ID) as HTMLDialogElement | null;

beforeEach(() => {
  ctx = setUp();
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const show = (surface: ProtectedSurface, account = "acct-a", epoch = 1) =>
  act(() => {
    surface.attachTree(account, epoch);
  });

describe("exposure (act) mounts or lifts, and only then", () => {
  test("the first attach mounts the tree and lifts the gate in one step", () => {
    expect(isGated(root())).toBe(true);
    let result: string | undefined;
    act(() => {
      result = ctx.surface.attachTree("acct-a", 1);
    });
    expect(result).toBe("mounted");
    expect(root().textContent).toContain("Heading of acct-a");
    expect(isGated(root())).toBe(false);
    expect(root().hasAttribute("inert")).toBe(false);
    expect(root().hasAttribute("aria-hidden")).toBe(false);
    // Focus goes to the new tree's main heading.
    expect(document.activeElement?.tagName).toBe("H1");
  });

  test("a second attach for the same account only lifts (the tree is not remounted)", () => {
    show(ctx.surface);
    const heading = root().querySelector("h1");
    let result: string | undefined;
    act(() => {
      ctx.surface.applyLevel0();
      result = ctx.surface.attachTree("acct-a", 1);
    });
    expect(result).toBe("lifted");
    expect(root().querySelector("h1")).toBe(heading);
  });
});

describe("level 0: hidden and pagehide", () => {
  test("applies the gate, neutral title and cleared live regions, with the modal gate opened last", () => {
    show(ctx.surface);
    act(() => {
      setProtectedTitle(["Today"]);
    });
    expect(document.title).toBe("Today · Atlas");
    ctx.calls.length = 0;
    act(() => ctx.surface.applyLevel0());
    expect(isGated(root())).toBe(true);
    expect(root().getAttribute("aria-hidden")).toBe("true");
    expect(document.title).toBe("Atlas");
    expect(ctx.live.clearAll).toHaveBeenCalled();
    expect(ctx.calls).toEqual(["dialog.open"]);
    const gate = dialog();
    expect(gate?.open).toBe(true);
    expect(gate?.getAttribute("aria-labelledby")).toBe("resume-gate-heading");
    const heading = gate?.querySelector("h1");
    expect(heading?.textContent).toBe(GATE_HEADING);
    expect(heading?.getAttribute("tabindex")).toBe("-1");
    expect(gate?.querySelector('[role="status"]')).not.toBeNull();
  });

  test("focus leaves the protected tree and lands on the gate heading", () => {
    show(ctx.surface);
    (root().querySelector('[data-focus-key="rename"]') as HTMLElement).focus();
    act(() => ctx.surface.applyLevel0());
    expect(root().contains(document.activeElement)).toBe(false);
    expect(document.activeElement?.id).toBe("resume-gate-heading");
  });

  test("Escape cannot dismiss the gate", () => {
    show(ctx.surface);
    act(() => ctx.surface.applyLevel0());
    const cancelled = !fireEvent(
      dialog() as HTMLDialogElement,
      new Event("cancel", { cancelable: true }),
    );
    expect(cancelled).toBe(true);
  });

  test("a title the tree asks for while gated is remembered and applied only on the same tree's lift", () => {
    show(ctx.surface);
    act(() => ctx.surface.applyLevel0());
    act(() => {
      setProtectedTitle(["Tasks"]);
    });
    expect(document.title).toBe("Atlas");
    show(ctx.surface);
    expect(document.title).toBe("Tasks · Atlas");
  });
});

describe("lift: focus and scroll are restored only by the same-account lift", () => {
  test("same account: focus returns to the control that had it, and scroll is restored", () => {
    show(ctx.surface);
    (root().querySelector('[data-focus-key="other"]') as HTMLElement).focus();
    Object.defineProperty(window, "scrollX", { value: 5, configurable: true });
    Object.defineProperty(window, "scrollY", {
      value: 240,
      configurable: true,
    });
    act(() => {
      ctx.surface.saveFocusAndScroll("acct-a", 1);
      ctx.surface.applyLevel0();
    });
    show(ctx.surface);
    expect(document.activeElement?.getAttribute("data-focus-key")).toBe(
      "other",
    );
    expect(window.scrollTo).toHaveBeenLastCalledWith(5, 240);
  });

  test("a saved position without a focus key falls back to the main heading", () => {
    show(ctx.surface);
    act(() => {
      ctx.surface.saveFocusAndScroll("acct-a", 1);
      ctx.surface.applyLevel0();
    });
    show(ctx.surface);
    expect(document.activeElement?.tagName).toBe("H1");
  });

  test("a different account: the old tree is unmounted, position discarded, a polite line announced without a name", () => {
    show(ctx.surface);
    (root().querySelector('[data-focus-key="other"]') as HTMLElement).focus();
    act(() => {
      ctx.surface.saveFocusAndScroll("acct-a", 1);
      ctx.surface.applyLevel0();
    });
    vi.mocked(window.scrollTo).mockClear();
    act(() => {
      ctx.surface.discardSavedPosition();
      ctx.surface.unmountTree();
    });
    expect(root().innerHTML).toBe("");
    show(ctx.surface, "acct-b", 2);
    expect(root().textContent).toContain("Heading of acct-b");
    expect(document.activeElement?.tagName).toBe("H1");
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(ctx.live.announce).toHaveBeenCalledWith(
      DIFFERENT_ACCOUNT_MESSAGE,
      "polite",
    );
    expect(DIFFERENT_ACCOUNT_MESSAGE).not.toMatch(/acct|@/);
  });

  test("attach for another account over a mounted tree replaces it and never restores the old position", () => {
    show(ctx.surface);
    (root().querySelector('[data-focus-key="other"]') as HTMLElement).focus();
    act(() => {
      ctx.surface.saveFocusAndScroll("acct-a", 1);
      ctx.surface.applyLevel0();
    });
    show(ctx.surface, "acct-b", 2);
    expect(root().textContent).toContain("Heading of acct-b");
    expect(root().textContent).not.toContain("acct-a");
    expect(document.activeElement?.getAttribute("data-focus-key")).not.toBe(
      "other",
    );
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  test("the first tree of a page announces nothing about accounts", () => {
    show(ctx.surface);
    expect(ctx.live.announce).not.toHaveBeenCalled();
  });
});

/**
 * WEB-08c revision 3 (R8, HF-13; design assessment S18, invariant 7): a successful same-account lift restores the keyed control and NO
 * obsolete callback takes focus afterwards. The adapter's own deferred heading focus (`focusHeading`, which waits up to 120 animation
 * frames for a heading the router renders after the commit) was cancelled by a newer heading request or an unmount, but NOT by a lift
 * that restored a keyed control, and once the heading existed it took focus even from a control the person had moved to. Animation
 * frames are queued here and run when the test says, so each order is exact.
 */
describe("HF-13: no obsolete heading focus after a mount, a level-0 gate or a restoring lift", () => {
  let frames: FrameRequestCallback[] = [];
  let headingShown = false;
  const listeners = new Set<() => void>();
  const showHeading = () => {
    headingShown = true;
    for (const listener of listeners) listener();
  };
  function LateHeading() {
    const shown = useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => headingShown,
    );
    return shown ? <h1>Late heading</h1> : null;
  }
  const runFrames = () => {
    // Every frame queued so far, and those they queue in turn, up to a bound (the adapter's own bound is 120).
    for (let round = 0; round < 200 && frames.length > 0; round += 1) {
      const due = frames;
      frames = [];
      act(() => {
        for (const callback of due) callback(0);
      });
    }
  };
  let late: ProtectedSurface;
  beforeEach(() => {
    frames = [];
    headingShown = false;
    listeners.clear();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    late = createProtectedSurface({
      renderTree: () => (
        <main>
          <LateHeading />
          <button type="button" data-focus-key="rename">
            Rename
          </button>
        </main>
      ),
      gateDialog: {
        ...ctx.gate,
        open() {
          ctx.gate.open();
          ctx.gate.focusHeading();
        },
        close() {
          ctx.gate.close();
        },
        focusHeading() {},
      },
      liveRegions: ctx.live,
    });
  });
  const keyed = () =>
    root().querySelector('[data-focus-key="rename"]') as HTMLElement;

  test("control: a heading that renders late is focused by the mount's deferred attempt when nothing else has focus", () => {
    act(() => {
      late.attachTree("acct-a", 1);
    });
    expect(frames.length).toBeGreaterThan(0);
    act(() => showHeading());
    runFrames();
    expect(document.activeElement?.textContent).toBe("Late heading");
  });

  test("the original schedule of HF-13: a keyed lift is not undone by the mount's still-pending heading attempt", () => {
    act(() => {
      late.attachTree("acct-a", 1);
    });
    act(() => showHeading());
    // The heading is in the DOM, the mount's attempt is still queued; the person focuses a keyed control, the page hides and is shown.
    keyed().focus();
    act(() => {
      late.saveFocusAndScroll("acct-a", 1);
      late.applyLevel0();
    });
    let result: string | undefined;
    act(() => {
      result = late.attachTree("acct-a", 1);
    });
    expect(result).toBe("lifted");
    expect(document.activeElement?.getAttribute("data-focus-key")).toBe(
      "rename",
    );
    runFrames();
    expect(document.activeElement?.getAttribute("data-focus-key")).toBe(
      "rename",
    );
  });

  test("a heading that renders late does not take focus from a control the person moved to inside the tree", () => {
    act(() => {
      late.attachTree("acct-a", 1);
    });
    keyed().focus();
    act(() => showHeading());
    runFrames();
    expect(document.activeElement?.getAttribute("data-focus-key")).toBe(
      "rename",
    );
  });

  test("a level-0 gate cancels the pending heading attempt: the gate keeps focus until the lift", () => {
    act(() => {
      late.attachTree("acct-a", 1);
    });
    act(() => {
      late.saveFocusAndScroll("acct-a", 1);
      late.applyLevel0();
    });
    act(() => showHeading());
    runFrames();
    expect(document.activeElement?.id).toBe("resume-gate-heading");
  });

  test("a saved target that is gone at the lift falls back to the heading (a separate expected result)", () => {
    act(() => {
      late.attachTree("acct-a", 1);
    });
    act(() => showHeading());
    runFrames();
    keyed().focus();
    act(() => {
      late.saveFocusAndScroll("acct-a", 1);
      late.applyLevel0();
    });
    keyed().remove();
    act(() => {
      late.attachTree("acct-a", 1);
    });
    runFrames();
    expect(document.activeElement?.textContent).toBe("Late heading");
  });
});

describe("level 1: a fence or a closed account leaves nothing protected", () => {
  test("unmount empties the root, keeps it gated, restores the neutral title and closes the gate dialog", () => {
    show(ctx.surface);
    act(() => {
      setProtectedTitle(["Today"]);
      ctx.surface.applyLevel0();
    });
    act(() => {
      ctx.surface.discardSavedPosition();
      ctx.surface.unmountTree();
    });
    expect(root().innerHTML).toBe("");
    expect(isGated(root())).toBe(true);
    expect(document.title).toBe("Atlas");
    expect(dialog()?.open).toBe(false);
    // A remembered title of the tree that no longer exists is not applied to the next.
    show(ctx.surface, "acct-b", 2);
    expect(document.title).toBe("Atlas");
  });

  test("unmounting twice, or with nothing mounted, is harmless", () => {
    expect(() => {
      act(() => ctx.surface.unmountTree());
      act(() => ctx.surface.unmountTree());
    }).not.toThrow();
  });
});

describe("the gate dialog's own contract", () => {
  test("it is labelled by its heading, its message is a status, and it carries no account data", () => {
    const gate = createGateDialog();
    gate.open();
    const element = document.getElementById(GATE_ID) as HTMLDialogElement;
    expect(element.getAttribute("aria-labelledby")).toBe("resume-gate-heading");
    expect(document.getElementById("resume-gate-heading")?.textContent).toBe(
      GATE_HEADING,
    );
    expect(element.querySelector('p[role="status"]')).not.toBeNull();
    expect(element.textContent).toBe(GATE_HEADING);
    gate.close();
    expect(element.open).toBe(false);
  });

  test("WEB-08c R4 (matrix 3.7.2 'Read pending', T22 t4): shown again while the gate is open, its status says 'Checking your account' ONCE; not while hidden; cleared by close", async () => {
    let visibility: "visible" | "hidden" = "hidden";
    Object.defineProperty(document, "visibilityState", {
      get: () => visibility,
      configurable: true,
    });
    try {
      const gate = createGateDialog();
      gate.open();
      const status = document.querySelector(
        `#${GATE_ID} [role="status"]`,
      ) as HTMLElement;
      const writes: string[] = [];
      const observer = new MutationObserver(() =>
        writes.push(status.textContent ?? ""),
      );
      observer.observe(status, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(status.textContent).toBe("");
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      expect(status.textContent).toBe(GATE_HEADING);
      expect(writes.filter((text) => text === GATE_HEADING)).toHaveLength(1);
      gate.close();
      expect(status.textContent).toBe("");
      // Closed: a later return writes nothing.
      document.dispatchEvent(new Event("visibilitychange"));
      expect(status.textContent).toBe("");
      observer.disconnect();
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  test("opening twice does not add a second dialog", () => {
    const gate = createGateDialog();
    gate.open();
    gate.open();
    expect(document.querySelectorAll(`#${GATE_ID}`)).toHaveLength(1);
  });
});
