// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  activeIsNewer,
  decideFetch,
  generationOf,
  generationOfCache,
  generationsOfEntry,
  PURGE_GRACE_MS,
  pathOf,
  planRetention,
  precacheCacheName,
} from "../../src/sw/core";

/**
 * WEB-14a: the service worker's pure decisions (D-P1 to D-P3). The fetch table mirrors docs/hosting.md and the reference nginx
 * configuration: the worker never answers a backend path (the OIDC callback included), a non-GET or a cross-origin request.
 */
const ORIGIN = "https://atlas.example";
const OWN = new Set([
  "/index.html",
  "/theme-init.js",
  "/manifest.webmanifest",
  "/assets/index-AAAA.js",
]);
const decide = (
  path: string,
  options: { method?: string; mode?: string; origin?: string } = {},
) =>
  decideFetch({
    method: options.method ?? "GET",
    mode: options.mode ?? "cors",
    url: new URL(path, options.origin ?? ORIGIN),
    origin: ORIGIN,
    ownPaths: OWN,
  });

describe("generations", () => {
  test("a manifest's generation is stable and independent of order", () => {
    const a = [
      { url: "index.html", revision: "1" },
      { url: "assets/x.js", revision: null },
    ];
    expect(generationOf(a)).toBe(generationOf([...a].reverse()));
    expect(generationOf(a)).toMatch(/^[0-9a-f]{16}$/);
  });
  test("a changed revision or file is another generation", () => {
    const a = [{ url: "index.html", revision: "1" }];
    expect(generationOf(a)).not.toBe(
      generationOf([{ url: "index.html", revision: "2" }]),
    );
    expect(generationOf(a)).not.toBe(
      generationOf([...a, { url: "assets/y.js", revision: null }]),
    );
  });
  test("paths and cache names", () => {
    expect(pathOf("index.html")).toBe("/index.html");
    expect(pathOf("/assets/x.js?v=1")).toBe("/assets/x.js");
    expect(generationOfCache(precacheCacheName("abc"))).toBe("abc");
    expect(generationOfCache("atlas-sw-state")).toBeNull();
    expect(generationOfCache("atlas-precache-")).toBeNull();
  });
});

describe("decideFetch: what the worker answers", () => {
  test.each([
    "/api",
    "/api/",
    "/api/experimental/v1/tasks",
    "/api?x=1",
    "/health",
    "/health?probe=1",
    "/ready",
    "/ready?probe=1",
    "/auth",
    "/auth?return_to=x",
    "/auth/callback",
    "/oidc",
    "/oidc/callback",
    "/oidc/callback?code=1&state=2",
  ])("backend path %s is passed, as a navigation and as a request", (path) => {
    expect(decide(path, { mode: "navigate" })).toEqual({ kind: "pass" });
    expect(decide(path)).toEqual({ kind: "pass" });
  });

  test.each([
    "/",
    "/today",
    "/tasks/never-visited",
    "/apiary",
    "/API/x",
    "/healthy",
    "/oidcx",
    "/settings?tab=1",
  ])("navigation to %s is the shell (case-sensitive, prefix-exact)", (path) => {
    expect(decide(path, { mode: "navigate" })).toEqual({ kind: "shell" });
  });

  test("a navigation to one of the generation's files is that file; to the shell's own path, the shell", () => {
    expect(decide("/manifest.webmanifest", { mode: "navigate" })).toEqual({
      kind: "asset",
      path: "/manifest.webmanifest",
    });
    expect(decide("/index.html", { mode: "navigate" })).toEqual({
      kind: "shell",
    });
  });

  test("non-GET is never answered, navigation or not", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      expect(decide("/today", { method, mode: "navigate" })).toEqual({
        kind: "pass",
      });
      expect(decide("/assets/index-AAAA.js", { method })).toEqual({
        kind: "pass",
      });
    }
  });

  test("cross-origin is never answered", () => {
    expect(
      decide("/assets/index-AAAA.js", { origin: "https://elsewhere.example" }),
    ).toEqual({ kind: "pass" });
    expect(
      decide("/today", {
        mode: "navigate",
        origin: "https://elsewhere.example",
      }),
    ).toEqual({ kind: "pass" });
  });

  test("the generation's files and any hashed asset are answered from the precache; anything else is passed", () => {
    expect(decide("/theme-init.js")).toEqual({
      kind: "asset",
      path: "/theme-init.js",
    });
    // An older open page's hashed file, not in this generation.
    expect(decide("/assets/old-BBBB.js")).toEqual({
      kind: "asset",
      path: "/assets/old-BBBB.js",
    });
    expect(decide("/robots.txt")).toEqual({ kind: "pass" });
    expect(decide("/sw.js")).toEqual({ kind: "pass" });
    expect(decide("/__atlas-sw/client/x")).toEqual({ kind: "pass" });
  });
});

describe("the page's generation", () => {
  const records = [
    { generation: "A", paths: ["/assets/a.js", "/index.html"], installedAt: 1 },
    { generation: "B", paths: ["/assets/b.js", "/index.html"], installedAt: 2 },
    { generation: "B2", paths: ["/assets/b.js"], installedAt: 3 },
  ];
  test("found by the entry script, newest first", () => {
    expect(generationsOfEntry("/assets/a.js", records)).toEqual(["A"]);
    expect(generationsOfEntry("/assets/b.js", records)).toEqual(["B2", "B"]);
    expect(generationsOfEntry("/assets/none.js", records)).toEqual([]);
  });
  test("newer: the active one was installed after every generation the page runs", () => {
    expect(activeIsNewer("B", ["A"], records)).toBe(true);
    expect(activeIsNewer("A", ["B"], records)).toBe(false);
    expect(activeIsNewer("A", ["A"], records)).toBe(false);
    expect(activeIsNewer("B", [], records)).toBe(false);
    expect(activeIsNewer("B2", ["B", "B2"], records)).toBe(false);
    expect(activeIsNewer("unknown", ["A"], records)).toBe(false);
  });
});

describe("planRetention (WEB-04 8: live generations, no fixed cap)", () => {
  const NOW = 1_000_000;
  const old = NOW - PURGE_GRACE_MS;
  const retained = [
    { generation: "A", retiredAt: old },
    { generation: "B", retiredAt: old },
    { generation: "C", retiredAt: null },
  ];
  test("acknowledged clients keep exactly theirs; the active generation is always kept", () => {
    expect(
      planRetention({
        active: "C",
        retained,
        clients: [{ id: "1", reported: ["A"] }],
        now: NOW,
      }),
    ).toEqual({ keep: ["A", "C"], purge: ["B"] });
  });
  test("one unacknowledged client keeps every generation", () => {
    expect(
      planRetention({
        active: "C",
        retained,
        clients: [
          { id: "1", reported: ["A"] },
          { id: "2", reported: null },
        ],
        now: NOW,
      }).purge,
    ).toEqual([]);
  });
  test("no clients: everything retired past the grace is purged, never the active one", () => {
    expect(
      planRetention({ active: "C", retained, clients: [], now: NOW }),
    ).toEqual({ keep: ["C"], purge: ["A", "B"] });
  });
  test("a generation retired within the grace is kept; one never retired (waiting) is kept", () => {
    const plan = planRetention({
      active: "C",
      retained: [
        { generation: "A", retiredAt: NOW - PURGE_GRACE_MS + 1 },
        { generation: "W", retiredAt: null },
        { generation: "C", retiredAt: null },
      ],
      clients: [],
      now: NOW,
    });
    expect(plan.purge).toEqual([]);
  });
  test("the active generation is kept even if marked retired", () => {
    expect(
      planRetention({
        active: "A",
        retained: [{ generation: "A", retiredAt: 0 }],
        clients: [{ id: "1", reported: ["B"] }],
        now: NOW,
      }).keep,
    ).toEqual(["A"]);
  });
  test("there is no cap: twenty live generations are all kept", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      generation: `G${i}`,
      retiredAt: 0,
    }));
    expect(
      planRetention({
        active: "G19",
        retained: many,
        clients: many.map((g, i) => ({ id: `${i}`, reported: [g.generation] })),
        now: NOW,
      }).purge,
    ).toEqual([]);
  });
});
