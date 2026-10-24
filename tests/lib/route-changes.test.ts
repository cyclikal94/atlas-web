import {
  createBrowserHistory,
  createMemoryHistory,
} from "@tanstack/react-router";
import { afterEach, describe, expect, test } from "vitest";
import {
  createHistoryRouteChanges,
  createRouteChanges,
} from "../../src/lib/route-changes";

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

/**
 * WEB-10a revision 22 (R34; design assessment DA22-I1..I3, Q3): the same record over a router's own history, for the component tests'
 * memory histories (which never move the document). It must tell exactly what the document's record tells for the same moves: every path
 * change once (push, replace, back, forward, go), with the new path, and no change of only the query or the fragment.
 */
describe("a router history's path changes (the memory-history equivalent)", () => {
  /**
   * The same moves made on the document (a browser history, which writes the address a microtask after each move: moves are made one at a
   * time) and on a memory history: what each record told.
   */
  async function both(
    moves: Array<(h: ReturnType<typeof createMemoryHistory>) => void>,
  ) {
    const { seen: documentSeen } = record();
    const browser = createBrowserHistory();
    cleanups.push(() => browser.destroy());
    for (const move of moves) {
      move(browser as never);
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
    }
    const memory = createMemoryHistory({ initialEntries: ["/"] });
    const changes = createHistoryRouteChanges(memory);
    const memorySeen: string[] = [];
    cleanups.push(changes.subscribe((path) => memorySeen.push(path)));
    for (const move of moves) move(memory);
    return { documentSeen, memorySeen, changes };
  }

  test("push and replace are told once per path change; the query and the fragment are not a change of path", async () => {
    const { documentSeen, memorySeen, changes } = await both([
      (h) => h.push("/tasks/a/edit"),
      (h) => h.push("/sync?tab=queue"),
      (h) => h.replace("/sync?tab=conflicts"),
      (h) => h.push("/tasks/a/edit#title"),
      (h) => h.replace("/tasks"),
    ]);
    expect(memorySeen).toEqual([
      "/tasks/a/edit",
      "/sync",
      "/tasks/a/edit",
      "/tasks",
    ]);
    expect(memorySeen).toEqual(documentSeen);
    expect(changes.pathname()).toBe("/tasks");
  });

  test("Back, Forward and go are told with the path moved to", () => {
    const memory = createMemoryHistory({ initialEntries: ["/tasks/a/edit"] });
    const changes = createHistoryRouteChanges(memory);
    const seen: string[] = [];
    cleanups.push(changes.subscribe((path) => seen.push(path)));
    memory.push("/sync");
    memory.back();
    memory.forward();
    memory.go(-1);
    expect(seen).toEqual(["/sync", "/tasks/a/edit", "/sync", "/tasks/a/edit"]);
    expect(changes.pathname()).toBe("/tasks/a/edit");
  });

  test("control: an unsubscribed listener is told nothing", () => {
    const memory = createMemoryHistory({ initialEntries: ["/"] });
    const changes = createHistoryRouteChanges(memory);
    const seen: string[] = [];
    const off = changes.subscribe((path) => seen.push(path));
    off();
    memory.push("/tasks");
    expect(seen).toEqual([]);
  });
});
