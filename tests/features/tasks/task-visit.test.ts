import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, describe, expect, test } from "vitest";
import {
  forgetTaskVisits,
  observeTaskRoutes,
  onTaskVisitEnded,
  type TaskVisit,
  visitHere,
} from "../../../src/features/tasks/visit";
import { createHistoryRouteChanges } from "../../../src/lib/route-changes";

/**
 * WEB-10a revision 22 (Review 22 R34; design assessment DA22-I1..I3, invariants 1, 3, 4 and 5): the logical visit of a task screen is
 * one address for one identity, observed from the route itself, not from any component. It goes on at its own address and at the sync
 * screens (whatever is or is not mounted), and ends on any other address or another identity; numbers are never reused; every end is told
 * once. Over a memory history (the adapter the component tests use, with the document record's semantics: `route-changes.test.ts`).
 */
const ME = "me:1";
const OTHER = "other:1";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  forgetTaskVisits();
});

function world(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  observeTaskRoutes(createHistoryRouteChanges(history));
  const ended: TaskVisit[] = [];
  cleanups.push(onTaskVisitEnded((visit) => ended.push(visit)));
  return { history, ended };
}

describe("a task screen's logical visit", () => {
  test("goes on at its own address and through the sync screens (queue or conflicts), Back or a push to the same address", () => {
    const { history, ended } = world("/tasks/a/edit");
    const visit = visitHere(ME);
    history.push("/sync?tab=queue");
    history.replace("/sync?tab=conflicts");
    expect(visit.ended()).toBe(false);
    history.back();
    expect(visit.ended()).toBe(false);
    history.push("/sync");
    history.push("/tasks/a/edit");
    expect(visit.ended()).toBe(false);
    expect(visitHere(ME)).toBe(visit);
    expect(ended).toEqual([]);
  });

  test("a change of only the query or the fragment is not a departure (the day picker's address)", () => {
    const { history } = world("/tasks/a");
    const visit = visitHere(ME);
    history.push("/tasks/a?occurrence=b");
    history.push("/tasks/a/#days");
    expect(visit.ended()).toBe(false);
    expect(visitHere(ME)).toBe(visit);
  });

  test("ends on any other address, from the screen or from the sync screens, with nothing mounted: told once", () => {
    const { history, ended } = world("/tasks/a/edit");
    const visit = visitHere(ME);
    history.push("/sync");
    history.push("/tasks");
    expect(visit.ended()).toBe(true);
    expect(ended).toEqual([visit]);
    history.push("/tasks/a/edit");
    const next = visitHere(ME);
    expect(next).not.toBe(visit);
    expect(next.generation).toBeGreaterThan(visit.generation);
    expect(next.ended()).toBe(false);
    history.push("/today");
    expect(ended).toEqual([visit, next]);
  });

  test("another identity at the same address ends it; it is never extended by the address alone", () => {
    const { ended } = world("/tasks/a/edit");
    const mine = visitHere(ME);
    const theirs = visitHere(OTHER);
    expect(mine.ended()).toBe(true);
    expect(theirs).not.toBe(mine);
    expect(theirs.identity).toBe(OTHER);
    expect(visitHere(ME)).not.toBe(mine);
    expect(ended.slice(0, 2)).toEqual([mine, theirs]);
  });

  test("a screen asking from another address (its router ahead of the observed one) begins that address's visit", () => {
    const { ended } = world("/tasks/a/edit");
    const a = visitHere(ME);
    const b = visitHere(ME, "/tasks/b/edit");
    expect(a.ended()).toBe(true);
    expect(b.address).toBe("/tasks/b/edit");
    expect(ended).toEqual([a]);
    expect(visitHere(ME, "/tasks/b/edit/")).toBe(b);
  });

  test("control: a new route source (a new router world) ends the visit going on", () => {
    const { ended } = world("/tasks/a/edit");
    const visit = visitHere(ME);
    world("/tasks/a/edit");
    expect(visit.ended()).toBe(true);
    expect(ended[0]).toBe(visit);
  });
});
