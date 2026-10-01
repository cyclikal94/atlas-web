import "@testing-library/jest-dom/vitest";

// The session tests run in the node environment (`// @vitest-environment node`) and have no DOM to patch.
if (typeof Element !== "undefined") {
  // jsdom lacks ResizeObserver, which Radix primitives use to measure controls.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??=
    ResizeObserverStub as unknown as typeof ResizeObserver;

  // jsdom lacks the pointer-capture and scroll APIs Radix calls on interaction.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
}
