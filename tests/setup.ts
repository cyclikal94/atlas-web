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
// WEB-14a revision 57 (Review 57, F-R57-1; design assessment C-F2, I-F1): a restored, chosen or returned focus target an owner named
// inside a recovery surface (its banner, another copy's actions, the check again) is refused by `focus.ts` and, in development and test
// builds, reported here: it fails the test whose editor named it, whatever that test asserts. A test of the refusal itself replaces the
// reporter for its own duration and puts this one back.
// In a MUTANT run (`ATLAS_MUTANT_DIR` set by scripts/mutation/unit-runner.mjs) the refusals are printed, not raised: an error from this
// hook is never evidence that a mutant was caught and would veto the test-body assertions that are (scripts/run-data-mutants.mjs); the
// cases that judge a mis-wired target assert the refusals in their own bodies. The unmutated CONTROL of every mutant, and every ordinary
// suite run, raise them as here.
const mutantRun = Boolean(process.env.ATLAS_MUTANT_DIR);
const surfaceRefusals: string[] = [];
const reportSurfaceRefusal = (kind: string, element: Element) => {
  surfaceRefusals.push(
    `${kind}: <${element.tagName.toLowerCase()}> "${(element.textContent ?? "").trim().slice(0, 60)}"`,
  );
};
(
  globalThis as { __atlasRecoverySurfaceRefused?: typeof reportSurfaceRefusal }
).__atlasRecoverySurfaceRefused = reportSurfaceRefusal;
afterEach(async () => {
  const refused = surfaceRefusals.splice(0);
  await endTestLifetime();
  if (refused.length > 0 && mutantRun)
    console.warn(
      `[I-F1 refused, mutant run] ${[...new Set(refused)].join("; ")}`,
    );
  else if (refused.length > 0)
    throw new Error(
      `I-F1: a restored editor named a focus target inside a recovery surface (refused): ${[...new Set(refused)].join("; ")}`,
    );
});
afterAll(() => {
  return endFileLifetime();
});
