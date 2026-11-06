import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { backendPaths } from "../../src/lib/backend-routes";
import { decideFetch } from "../../src/sw/core";

/**
 * WEB-19, P-12: the activity timeline is identity-bound, `Cache-Control: private, no-store` display data. The client keeps it in page
 * memory only, so the service worker (WEB-14a) must never cache it: the worker precaches the build and serves the app shell to
 * navigations, and nothing else.
 *
 * WEB-14a maintenance merge of accepted main 74b0baca (6 November 2026): WEB-19 pinned this by the source of the minimal worker main had
 * then (one Workbox navigation route, no Cache Storage of its own). WEB-14a's worker, the one P-12 names, keeps each generation's precache
 * in a Cache Storage of its own (`atlas-precache-<generation>`), routes a generation's static files itself and keeps its own lifecycle
 * records; so the same rule is pinned here against that worker. It stores only its own generation's files (the install's `addAll` of its
 * own paths, and a lost own file added again) and records it makes itself (JSON), never a network answer; it has no runtime caching
 * strategy and no fetch handler of its own; both its routes are decided by `decideFetch`, which passes every backend path (the activity
 * endpoint included) to the network in every mode, so the worker never answers it, let alone caches it.
 */
const read = (path: string) =>
  readFileSync(join(__dirname, "../..", path), "utf8");
const sw = read("src/sw.ts");
const state = read("src/sw/state.ts");
const core = read("src/sw/core.ts");
const ACTIVITY =
  "/api/experimental/v1/people/55555555-5555-4555-8555-555555555555/activity?limit=5";

describe("P-12: the service worker never caches an API answer such as GET /people/{id}/activity", () => {
  test("only the precache and the worker's own records: no runtime caching, no fetch handler, no network answer stored", () => {
    for (const source of [sw, state, core]) {
      expect(source).not.toMatch(/workbox-strategies|workbox-expiration/);
      expect(source).not.toMatch(
        /CacheFirst|NetworkFirst|StaleWhileRevalidate|CacheOnly/,
      );
      expect(source).not.toMatch(/addEventListener\(\s*["']fetch["']/);
      expect(source).not.toMatch(/\bfetch\(/);
    }
    // The worker's own Cache Storage writes: its generation's files at install, and a lost own file added again.
    expect(sw).not.toMatch(/\.put\(/);
    expect(sw.match(/\.addAll\(/g)).toHaveLength(1);
    expect(sw).toMatch(/cache\.addAll\(\s*\[\.\.\.ownPaths\]/);
    expect(sw.match(/\bcache\.add\(/g)).toHaveLength(1);
    // Its lifecycle records: JSON it makes itself, under its own keys.
    const puts = [...state.matchAll(/\.put\(([\s\S]*?)\);/g)].map((m) => m[1]);
    expect(puts).toHaveLength(2);
    for (const put of puts) expect(put).toMatch(/json\(record\)/);
    // Two routes, both decided by `decideFetch`; navigations never answer a backend path.
    expect(sw.match(/registerRoute\(/g)).toHaveLength(2);
    expect(sw).toMatch(/new NavigationRoute\(/);
    expect(sw).toMatch(/denylist: backendPaths/);
    expect(sw.match(/decideFetch\(/g)).toHaveLength(2);
  });

  test("the worker does not answer the activity endpoint at all: `decideFetch` passes it to the network in every mode", () => {
    const url = new URL(`https://atlas.example${ACTIVITY}`);
    for (const mode of ["cors", "same-origin", "no-cors", "navigate"])
      expect(
        decideFetch({
          method: "GET",
          mode,
          url,
          origin: url.origin,
          ownPaths: new Set(["/index.html", "/assets/index.js"]),
        }),
        mode,
      ).toEqual({ kind: "pass" });
  });

  test("the activity endpoint is a backend path", () => {
    expect(backendPaths.some((pattern) => pattern.test(ACTIVITY))).toBe(true);
  });
});
