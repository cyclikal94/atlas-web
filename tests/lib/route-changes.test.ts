import { createBrowserHistory } from "@tanstack/react-router";
import { afterEach, describe, expect, test } from "vitest";
import { createRouteChanges } from "../../src/lib/route-changes";

/**
 * Revision 6 of WEB-13a (R13; design assessment C2, Q9, Q10): the document's own record of its path. It must see every path change,
 * whoever makes it (a router's history, a raw `pushState`/`replaceState`, Back/Forward/`go`), whether or not any router exists, and must
 * survive routers being made and torn down after it. jsdom's real `History` and `popstate` are used.
 */
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  window.history.replaceState(null, "", "/");
});

function record() {
  const changes = createRouteChanges(window);
  cleanups.push(() => changes.destroy());
  const seen: string[] = [];
  cleanups.push(changes.subscribe((path) => seen.push(path)));
  return { changes, seen };
}

const popped = () =>
  new Promise<void>((resolve) =>
    window.addEventListener("popstate", () => resolve(), { once: true }),
  );

describe("the document's path changes", () => {
  test("raw pushState and replaceState are told once per path change; the query and the fragment are not a change of path", () => {
    const { changes, seen } = record();
    window.history.pushState(null, "", "/settings");
    window.history.replaceState(null, "", "/settings/calendars");
    window.history.pushState(null, "", "/settings/calendars?x=1#y");
    window.history.replaceState(null, "", "/settings/calendars");
    expect(seen).toEqual(["/settings", "/settings/calendars"]);
    expect(changes.pathname()).toBe("/settings/calendars");
  });

  test("Back and Forward (popstate) are told, with no router at all", async () => {
    const { seen } = record();
    window.history.pushState(null, "", "/settings");
    window.history.pushState(null, "", "/settings/calendars");
    let pop = popped();
    window.history.back();
    await pop;
    pop = popped();
    window.history.go(1);
    await pop;
    expect(seen).toEqual([
      "/settings",
      "/settings/calendars",
      "/settings",
      "/settings/calendars",
    ]);
  });

  test("a router's history made AFTER it: its push and replace (batched to a microtask) are told, and its teardown leaves the record in place", async () => {
    const { seen } = record();
    const history = createBrowserHistory();
    history.push("/settings");
    history.replace("/settings/calendars");
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.at(-1)).toBe("/settings/calendars");
    history.destroy();
    window.history.pushState(null, "", "/today");
    expect(seen.at(-1)).toBe("/today");
  });

  test("routers made and abandoned one after another (each protected mount makes one) do not hide a change", async () => {
    const { seen } = record();
    for (let i = 0; i < 3; i += 1) createBrowserHistory();
    const latest = createBrowserHistory();
    latest.push("/sync");
    await Promise.resolve();
    window.history.pushState(null, "", "/people");
    expect(seen).toEqual(["/sync", "/people"]);
  });

  test("control: an unsubscribed listener and a destroyed record are told nothing", () => {
    const changes = createRouteChanges(window);
    const seen: string[] = [];
    const off = changes.subscribe((path) => seen.push(path));
    off();
    window.history.pushState(null, "", "/a");
    changes.destroy();
    window.history.pushState(null, "", "/b");
    expect(seen).toEqual([]);
  });
});
