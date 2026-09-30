import { describe, expect, test } from "vitest";
import { backendPaths } from "../../src/lib/backend-routes";

const isBackend = (path: string) =>
  backendPaths.some((pattern) => pattern.test(path));

describe("backend paths never receive the offline app shell", () => {
  test.each([
    "/api/experimental/v1/tasks",
    "/api",
    "/api/",
    "/api?probe=1",
    "/health",
    "/ready",
    "/auth/callback",
    "/oidc/callback",
    "/health?probe=1",
    "/ready?probe=1",
    "/auth?return_to=x",
    "/auth",
    "/oidc",
  ])("%s is a backend path", (path) => {
    expect(isBackend(path)).toBe(true);
  });

  test.each([
    "/",
    "/today",
    "/tasks/123",
    "/settings/appearance",
    "/healthy",
    "/readyish",
    "/authors",
    "/oidcish",
    "/apiary",
    "/assets/index-abc.js",
    "/_web/health",
    "/_web/provenance.json",
  ])("%s is eligible for the shell (or frontend-reserved)", (path) => {
    expect(isBackend(path)).toBe(false);
  });

  test("matching is case-sensitive, the same as the reverse proxy and the service worker", () => {
    expect(isBackend("/API/x")).toBe(false);
    expect(isBackend("/Health")).toBe(false);
  });

  test("a doubled slash is not a backend path, so the proxy must normalise before matching (documented in docs/hosting.md)", () => {
    expect(isBackend("//api/x")).toBe(false);
  });
});
