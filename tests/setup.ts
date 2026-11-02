import { loadavg } from "node:os";
import { afterAll, afterEach, beforeEach } from "vitest";
import {
  beginTestLifetime,
  endFileLifetime,
  endTestLifetime,
} from "./support/lifetime";
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

// R30/DA-H1 (revision 25): whatever a test created that keeps running (a fake world's automatic driver, a dispatcher) ends with the
// test, passed, failed or timed out; a file's own ends with the file. A driver failure it recorded fails the test that owned it.
beforeEach((context) => {
  beginTestLifetime();
  // A failed case says what it cost this process and how loaded the host was (R30, revision 25): a time-out with little CPU of its
  // own is a case that was not scheduled, which is a different finding from one that worked for the whole budget.
  const wall = performance.now();
  const cpu = process.cpuUsage();
  context.onTestFailed(() => {
    const used = process.cpuUsage(cpu);
    console.error(
      `[case-resources] ${context.task.name}: wall ${Math.round(performance.now() - wall)} ms, process CPU ${Math.round((used.user + used.system) / 1000)} ms, load ${loadavg()
        .map((value) => value.toFixed(2))
        .join(" ")}`,
    );
  });
});
afterEach(() => {
  return endTestLifetime();
});
afterAll(() => {
  return endFileLifetime();
});
