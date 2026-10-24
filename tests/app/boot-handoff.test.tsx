import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * U-HAND-1, call order: `boot()` copies and strips the URL fragment as its FIRST synchronous act, before the capability
 * check, before `openAuthStore` (made deliberately slow), before any request. The grant and the invitation token never sit
 * in the address bar while the page works.
 */
const calls = vi.hoisted(() => [] as string[]);

vi.mock("../../src/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/session")>();
  return {
    ...actual,
    openAuthStore: vi.fn(() => {
      calls.push("openAuthStore");
      return new Promise(() => undefined);
    }),
  };
});
// The call order under test does not depend on anything React draws. A real root's commit schedules a passive-effect flush that
// reads `window.event`; on a loaded host it could run after this file's environment was torn down ("window is not defined", an
// unhandled error outside every test). The roots are therefore inert here.
vi.mock("react-dom/client", () => ({
  createRoot: vi.fn(() => ({ render: vi.fn(), unmount: vi.fn() })),
}));
vi.mock("../../src/app/capabilities", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/app/capabilities")>();
  return {
    ...actual,
    checkCapabilities: vi.fn(() => {
      calls.push("checkCapabilities");
      return { ok: true, issues: [] };
    }),
  };
});

import { boot } from "../../src/app/boot";
import { invitationMemory } from "../../src/features/authentication/handoff";

const GRANT = "a".repeat(64);
const ACCOUNT = "123e4567-e89b-12d3-a456-426614174000";
const TOKEN = "c".repeat(64);

beforeEach(() => {
  calls.length = 0;
  invitationMemory.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
  invitationMemory.clear();
});

const run = () => {
  const root = document.createElement("div");
  document.body.append(root);
  const replace = vi
    .spyOn(history, "replaceState")
    .mockImplementation((...args) => {
      calls.push("replaceState");
      // jsdom keeps the real behaviour so the test can read `location`.
      return History.prototype.replaceState.apply(history, args as never);
    });
  void boot({ neutralRoot: root });
  return replace;
};

describe("boot: the fragment is stripped before anything else happens", () => {
  test("an OIDC landing: stripped synchronously, before the capability check and the (slow) store open", () => {
    history.replaceState(
      null,
      "",
      `/#atlas_grant=${GRANT}&atlas_attempt=3&atlas_account=${ACCOUNT}`,
    );
    calls.length = 0;
    const replace = run();
    // Synchronously after `boot()` returned its promise: no await has happened yet.
    expect(calls[0]).toBe("replaceState");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe("");
    expect(location.href).not.toContain(GRANT);
    expect(calls.indexOf("replaceState")).toBeLessThan(
      calls.indexOf("checkCapabilities"),
    );
  });

  test("an invitation link: the token moves into memory and out of the URL before the first await", () => {
    history.replaceState(null, "", `/join#t=${TOKEN}`);
    calls.length = 0;
    run();
    expect(calls[0]).toBe("replaceState");
    expect(location.pathname).toBe("/join");
    expect(location.hash).toBe("");
    expect(invitationMemory.peek()).toBe(TOKEN);
    expect(location.href).not.toContain(TOKEN);
  });

  test("no recognised key: replaceState is not called at all", () => {
    history.replaceState(null, "", "/tasks#section");
    calls.length = 0;
    run();
    expect(calls).not.toContain("replaceState");
    expect(location.hash).toBe("#section");
  });

  test("a token away from /join is not ours: left in place and not remembered", () => {
    history.replaceState(null, "", `/tasks#t=${TOKEN}`);
    calls.length = 0;
    run();
    expect(calls).not.toContain("replaceState");
    expect(invitationMemory.peek()).toBeNull();
  });

  test("a fragment-only navigation (another link pasted into the open page) is captured and stripped like the first load", async () => {
    history.replaceState(null, "", "/join");
    calls.length = 0;
    run();
    // jsdom fires `hashchange` asynchronously for an assignment to `location.hash`.
    location.hash = `#t=${TOKEN}`;
    await vi.waitFor(() => expect(location.hash).toBe(""));
    expect(location.pathname).toBe("/join");
    expect(invitationMemory.peek()).toBe(TOKEN);
    expect(location.href).not.toContain(TOKEN);
  });
});
