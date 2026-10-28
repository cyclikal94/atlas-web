import { type ReactNode, useEffect } from "react";

/**
 * FIXTURE ONLY. The diagnostic pages (`/__neutral`, `/__controls`, `/__gate`) load on demand, after the page's load event, so a
 * spec cannot measure them as soon as `page.goto` returns. Each marks `<html data-fixture-page="ready">` once it is mounted and
 * its effects have run (the neutral heading's focus included); `fixturePageReady` in tests/e2e/helpers.ts waits for it.
 */
export function markFixturePageReady(): void {
  document.documentElement.dataset.fixturePage = "ready";
}

/** A parent's effects run after its children's in the same commit, so when this marks the page ready the page's own effects have run. */
export function FixturePageReady({ children }: { children: ReactNode }) {
  useEffect(markFixturePageReady, []);
  return children;
}
