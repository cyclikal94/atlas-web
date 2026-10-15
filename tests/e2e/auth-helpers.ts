import { test as base, expect } from "@playwright/test";

/**
 * The console guard of tests/e2e/helpers.ts, with the one thing a flow that talks to a STUBBED API needs: a test DECLARES the
 * HTTP statuses (and aborted connections) it provokes on purpose, because the browser logs every 4xx and failed request as a
 * console error even when the application handles it. Anything else still fails the test.
 *
 * `idb-navigation-abort` (WEB-10a revision 7): ONLY Firefox's warning that an unfinished IndexedDB transaction was aborted by a page
 * navigation, for the one case that holds a transaction open and navigates on purpose; it is counted (`provokedIdbWarnings`) so that
 * case can show it was provoked. No other test declares it.
 */
type Provoked = number | "abort" | "idb-navigation-abort";
const IDB_NAVIGATION_ABORT =
  /An IndexedDB transaction that was not yet complete has been aborted due to page navigation\./;
export const test = base.extend<{
  provokes: (...provoked: Provoked[]) => void;
  guard: undefined;
}>({
  provokes: async ({ page: _page }, use, info) => {
    const allowed = new Set<Provoked>();
    allowedByTest.set(info.testId, allowed);
    await use((...provoked) => {
      for (const one of provoked) allowed.add(one);
    });
  },
  guard: [
    async ({ page, provokes: _provokes }, use, info) => {
      const problems: string[] = [];
      page.on("console", (message) => {
        if (message.type() !== "error" && message.type() !== "warning") return;
        const text = message.text();
        const allowed = allowedByTest.get(info.testId) ?? new Set();
        const status = /status of (\d{3})/.exec(text)?.[1];
        if (status && allowed.has(Number(status))) return;
        if (
          allowed.has("idb-navigation-abort") &&
          message.type() === "warning" &&
          IDB_NAVIGATION_ABORT.test(text)
        ) {
          idbWarnings.set(info.testId, (idbWarnings.get(info.testId) ?? 0) + 1);
          return;
        }
        if (
          allowed.has("abort") &&
          /ERR_|NetworkError|Load failed|Failed to fetch/i.test(text)
        )
          return;
        // Firefox and WebKit name the resource instead of the status.
        if (
          [...allowed].some((one) => typeof one === "number") &&
          /Failed to load resource|NetworkError|the server responded/i.test(
            text,
          )
        )
          return;
        problems.push(`${message.type()}: ${text}`);
      });
      page.on("pageerror", (error) =>
        problems.push(`pageerror: ${error.message}`),
      );
      await use(undefined);
      expect(
        problems,
        "console errors and warnings (other than what this test provokes)",
      ).toEqual([]);
    },
    { auto: true },
  ],
});
const allowedByTest = new Map<string, Set<Provoked>>();
const idbWarnings = new Map<string, number>();
/** How many declared `idb-navigation-abort` warnings the test has seen so far. */
export const provokedIdbWarnings = (testId: string): number =>
  idbWarnings.get(testId) ?? 0;

export { expect };
