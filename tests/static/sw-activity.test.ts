import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { backendPaths } from "../../src/lib/backend-routes";

/**
 * WEB-19, P-12: the activity timeline is identity-bound, `Cache-Control: private, no-store` display data. The client keeps it in page
 * memory only, so the service worker (WEB-14a) must never cache it: the worker precaches the build and serves the app shell to
 * navigations, and nothing else. This pins that by its source (no runtime caching strategy, no fetch handler, no Cache Storage of its
 * own), and that the activity endpoint is a backend path (never answered with the shell).
 */
const source = readFileSync(join(__dirname, "../../src/sw.ts"), "utf8");

describe("P-12: the service worker never caches an API answer such as GET /people/{id}/activity", () => {
  test("only the precache and the navigation route: no runtime caching, fetch handler or Cache Storage", () => {
    expect(source).not.toMatch(/workbox-strategies|workbox-expiration/);
    expect(source).not.toMatch(
      /CacheFirst|NetworkFirst|StaleWhileRevalidate|CacheOnly/,
    );
    expect(source).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(source).not.toMatch(/\bcaches\.(open|match|put)\b/);
    expect(source.match(/registerRoute\(/g)).toHaveLength(1);
    expect(source).toMatch(/new NavigationRoute\(/);
    expect(source).toMatch(/denylist: backendPaths/);
  });

  test("the activity endpoint is a backend path", () => {
    const path =
      "/api/experimental/v1/people/55555555-5555-4555-8555-555555555555/activity?limit=5";
    expect(backendPaths.some((pattern) => pattern.test(path))).toBe(true);
  });
});
