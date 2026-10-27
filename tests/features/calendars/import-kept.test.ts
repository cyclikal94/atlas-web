import { afterEach, describe, expect, test } from "vitest";
import type { GateState } from "../../../src/data";
import {
  discardImport,
  forgetImportSessions,
  hideImport,
  type ImportOwnerContext,
  importOwned,
  openImport,
  resumeChooser,
  showImport,
} from "../../../src/features/calendars/import-kept";
import type { RouteChanges } from "../../../src/lib/route-changes";

/**
 * WEB-13b revision 6 (review 6 R7; design assessment C1/C2, invariants 1-3, 7-8, schedules I11-I13): the owner of the import dialog's
 * editing session, over a route record and an identity the test moves itself.
 */
function routesAt(start: string) {
  let path = start;
  const listeners = new Set<(pathname: string) => void>();
  const routes: RouteChanges = {
    pathname: () => path,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    routes,
    go(to: string) {
      if (to === path) return;
      path = to;
      for (const listener of [...listeners]) listener(to);
    },
    listeners: () => listeners.size,
  };
}

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listeners: () => listeners.size,
  };
}

const A = { account_id: "a", epoch: 1 };
const B = { account_id: "b", epoch: 1 };

function world(start = "/settings/calendars") {
  const route = routesAt(start);
  forgetImportSessions(route.routes);
  const identities = store<{ account_id: string; epoch: number } | null>(A);
  const gate = store<GateState>("open");
  const context = (
    over: Partial<ImportOwnerContext> = {},
  ): ImportOwnerContext => ({
    identity: "a:1",
    identities,
    incarnation: "i1",
    gate,
    today: "2026-10-27",
    ...over,
  });
  return { route, identities, gate, context };
}

const ROW = { kind: "row", sourceId: "s1" } as const;
const OTHER_ROW = { kind: "row", sourceId: "s2" } as const;
const CHOOSER = { kind: "chooser" } as const;

afterEach(() => forgetImportSessions());

describe("the import's visit (I13)", () => {
  test("kept through the sync screens and back; the same row shows the SAME session", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    first.editWindow({ from: "2026-01-01" });
    hideImport(first);
    w.route.go("/sync");
    w.route.go("/settings/calendars");
    const again = openImport(ROW, w.context());
    expect(again).toBe(first);
    expect(again.state().window.from).toBe("2026-01-01");
  });

  test("an ordinary departure (from the screen, or from the sync screens) ends it, mounted or not", () => {
    for (const away of [["/settings"], ["/sync", "/tasks"]]) {
      const w = world();
      const first = openImport(ROW, w.context());
      hideImport(first);
      for (const to of away) w.route.go(to);
      expect(first.ended()).toBe(true);
      w.route.go("/settings/calendars");
      expect(openImport(ROW, w.context())).not.toBe(first);
    }
  });

  test("rapid away and back in one turn still ends it (the document's every change is heard)", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    w.route.go("/settings");
    w.route.go("/settings/calendars");
    expect(first.ended()).toBe(true);
  });

  test("a session ended by its visit holds no subscription", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    expect(w.route.listeners()).toBe(1);
    w.route.go("/settings");
    expect(first.ended()).toBe(true);
    expect(w.route.listeners()).toBe(0);
    expect(w.identities.listeners()).toBe(0);
    expect(w.gate.listeners()).toBe(0);
  });

  test("a session opened outside the Calendars screen is kept only while shown", () => {
    const w = world("/elsewhere");
    const first = openImport(ROW, w.context());
    hideImport(first);
    expect(first.ended()).toBe(true);
  });
});

describe("entries and discards (C2, I4, I11)", () => {
  test("a different row is a deliberate new edit: the kept session ends", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    hideImport(first);
    const other = openImport(OTHER_ROW, w.context());
    expect(other).not.toBe(first);
    expect(first.ended()).toBe(true);
  });

  test("Browse resumes only the chooser's kept session; a row's kept session is not a chooser", () => {
    const w = world();
    const row = openImport(ROW, w.context());
    hideImport(row);
    expect(resumeChooser(w.context())).toBeNull();
    expect(row.ended()).toBe(false);
    const chooser = openImport(CHOOSER, w.context());
    expect(row.ended()).toBe(true);
    hideImport(chooser);
    expect(resumeChooser(w.context())).toBe(chooser);
  });

  test("discard ends that session only; a stale discard of an old session never ends the new one", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    discardImport(first);
    expect(first.ended()).toBe(true);
    const second = openImport(ROW, w.context());
    expect(second).not.toBe(first);
    discardImport(first);
    hideImport(first);
    expect(second.ended()).toBe(false);
    expect(openImport(ROW, w.context())).toBe(second);
  });

  test("a consumed session leaves (the next open is new)", async () => {
    const w = world();
    const first = openImport(ROW, w.context());
    first.submit(
      { source: "s1", from: "x", through: "y", file: 1 },
      async () => ({ kind: "queued" }),
    );
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(first.ended()).toBe(true);
    expect(openImport(ROW, w.context())).not.toBe(first);
  });
});

describe("identity, database and cache (I12)", () => {
  test("A→B→A while hidden: the session ends at B and A gets a NEW session", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    first.editWindow({ from: "2026-01-01" });
    hideImport(first);
    w.identities.set(B);
    expect(first.ended()).toBe(true);
    w.identities.set(A);
    const again = openImport(ROW, w.context());
    expect(again).not.toBe(first);
    expect(again.state().window.from).not.toBe("2026-01-01");
  });

  test("signed out while hidden ends it; the same identity told again keeps it (control)", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    hideImport(first);
    w.identities.set({ ...A });
    expect(first.ended()).toBe(false);
    w.identities.set(null);
    expect(first.ended()).toBe(true);
  });

  test("another database for the same identity: not shown again, not saved", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    expect(importOwned(first, w.context())).toBe(true);
    expect(importOwned(first, w.context({ incarnation: "i2" }))).toBe(false);
    hideImport(first);
    const again = openImport(ROW, w.context({ incarnation: "i2" }));
    expect(again).not.toBe(first);
    expect(first.ended()).toBe(true);
  });

  test("no database yet is not another database (nothing can be saved without one)", () => {
    const w = world();
    const first = openImport(ROW, w.context({ incarnation: null }));
    hideImport(first);
    expect(openImport(ROW, w.context())).toBe(first);
    expect(importOwned(first, w.context({ incarnation: "i2" }))).toBe(false);
  });

  test("the cache hidden to be brought up to date ends a kept session; a shown one is the dialog's (E9)", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    w.gate.set("refreshing");
    expect(first.ended()).toBe(false);
    w.gate.set("open");
    hideImport(first);
    w.gate.set("refreshing");
    expect(first.ended()).toBe(true);
  });

  test("shown again (a remount of the same dialog) is not hidden", () => {
    const w = world();
    const first = openImport(ROW, w.context());
    hideImport(first);
    showImport(first);
    w.gate.set("floor");
    expect(first.ended()).toBe(false);
  });
});
