import { cleanup, render } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, expect, test } from "vitest";
import { Welcome } from "../src/app/router";
import { backendPaths } from "../src/lib/backend-routes";

afterEach(cleanup);
test("neutral entry has no accessibility violations", async () => {
  const { container } = render(<Welcome />);
  expect((await axe(container)).violations).toEqual([]);
});
test.each([
  "/api/experimental/v1/tasks",
  "/health",
  "/ready",
  "/auth/callback",
  "/oidc/callback",
  "/health?probe=1",
  "/ready?probe=1",
  "/auth?return_to=x",
])("%s cannot receive an offline app shell", (path) => {
  expect(backendPaths.some((pattern) => pattern.test(path))).toBe(true);
});
test("client deep links are eligible for the shell", () => {
  expect(backendPaths.some((pattern) => pattern.test("/tasks/123"))).toBe(
    false,
  );
});
