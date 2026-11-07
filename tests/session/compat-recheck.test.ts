import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/session/constants";
import { Fixture } from "../support/session/harness";

/**
 * WEB-14a, D-P9: the API-version check is asked at boot and again at every reconnect (WEB-03 3.9a, delivery-slices `api_version` cases
 * 1-3), on a return to the page once `compatRecheckMinIntervalMs` has passed, and on a paced timer while the answer is not `supported`.
 * One check is in flight; a trigger during it asks for exactly one more after it. Production constants throughout (fake time).
 */
const healthCount = (f: Fixture) =>
  f.server.requests.filter((r) => r.path === "/health").length;

/** `null`: the server reports no `api_version` at all (case 1, missing). */
const booted = async (apiVersion: string | null) => {
  const f = new Fixture();
  f.server.apiVersion = apiVersion ?? undefined;
  const page = f.addPage();
  await f.boot(page);
  await f.settle();
  return { f, page };
};

describe("the re-check triggers", () => {
  test("a server upgraded under an open tab is noticed at the next reconnect", async () => {
    const { f, page } = await booted("0.31.0");
    expect(page.session.compat.get().status).toBe("supported");
    f.server.apiVersion = "0.32.0";
    page.goOffline();
    await f.settle();
    page.goOnline();
    await f.settle();
    expect(page.session.compat.get()).toMatchObject({
      status: "unsupported",
      version: "0.32.0",
    });
    // A later fix (or downgrade) is noticed the same way and resumes without a reload.
    f.server.apiVersion = "0.31.4";
    page.goOffline();
    page.goOnline();
    await f.settle();
    expect(page.session.compat.get()).toMatchObject({ status: "supported" });
  });

  test.each(["visible", "focus", "pageshow", "resume"] as const)(
    "a return to the page (%s) asks again only after the minimum interval",
    async (event) => {
      const { f, page } = await booted("0.31.0");
      expect(healthCount(f)).toBe(1);
      f.server.apiVersion = "0.32.0";
      await f.world.advance(DEFAULT_CONFIG.compatRecheckMinIntervalMs - 1);
      page.env.emit(event);
      await f.settle();
      expect(healthCount(f)).toBe(1);
      expect(page.session.compat.get().status).toBe("supported");
      await f.world.advance(1);
      page.env.emit(event);
      await f.settle();
      expect(healthCount(f)).toBe(2);
      expect(page.session.compat.get().status).toBe("unsupported");
    },
  );

  test("recheckCompatibility asks at once", async () => {
    const { f, page } = await booted("0.31.0");
    f.server.apiVersion = undefined;
    page.session.recheckCompatibility();
    await f.settle();
    expect(healthCount(f)).toBe(2);
    expect(page.session.compat.get()).toEqual({ status: "missing" });
  });
});

describe("the paced re-check while the answer is not supported", () => {
  test("missing: asked again on a doubling pace, and lifted once the server reports a supported version", async () => {
    const { f, page } = await booted(null);
    expect(page.session.compat.get()).toEqual({ status: "missing" });
    await f.world.advance(DEFAULT_CONFIG.compatRetryInitialMs - 1);
    expect(healthCount(f)).toBe(1);
    await f.world.advance(1);
    expect(healthCount(f)).toBe(2);
    // The second wait is twice the first.
    await f.world.advance(2 * DEFAULT_CONFIG.compatRetryInitialMs - 1);
    expect(healthCount(f)).toBe(2);
    await f.world.advance(1);
    expect(healthCount(f)).toBe(3);
    f.server.apiVersion = "0.31.0";
    await f.world.advance(4 * DEFAULT_CONFIG.compatRetryInitialMs);
    expect(page.session.compat.get()).toMatchObject({ status: "supported" });
    const settled = healthCount(f);
    // Supported needs no timer: an hour of fake time asks nothing more.
    await f.world.advance(3_600_000);
    expect(healthCount(f)).toBe(settled);
  });

  test("the pace is capped at compatRetryMaxMs", async () => {
    const { f } = await booted("0.32.0");
    // 30 s, 60 s, 120 s, 240 s, 480 s, then 600 s each.
    await f.world.advance(30_000 + 60_000 + 120_000 + 240_000 + 480_000);
    expect(healthCount(f)).toBe(6);
    await f.world.advance(DEFAULT_CONFIG.compatRetryMaxMs - 1);
    expect(healthCount(f)).toBe(6);
    await f.world.advance(1);
    expect(healthCount(f)).toBe(7);
  });

  test("the pace starts again when the answer changes", async () => {
    const { f, page } = await booted(null);
    await f.world.advance(30_000 + 60_000);
    expect(healthCount(f)).toBe(3);
    f.server.apiVersion = "0.32.0";
    await f.world.advance(120_000);
    expect(healthCount(f)).toBe(4);
    expect(page.session.compat.get().status).toBe("unsupported");
    // A changed answer: the next wait is the initial one again, not 240 s.
    await f.world.advance(DEFAULT_CONFIG.compatRetryInitialMs);
    expect(healthCount(f)).toBe(5);
  });

  test("an offline page reports unreachable with no request, paced or not, and asks at reconnect", async () => {
    const f = new Fixture();
    const page = f.addPage();
    page.env.online = false;
    await f.boot(page);
    await f.settle();
    await f.world.advance(DEFAULT_CONFIG.compatRetryMaxMs * 3);
    expect(healthCount(f)).toBe(0);
    expect(page.session.compat.get()).toEqual({ status: "unreachable" });
    page.goOnline();
    await f.settle();
    expect(healthCount(f)).toBe(1);
    expect(page.session.compat.get().status).toBe("supported");
  });

  test("dispose stops the paced re-check", async () => {
    const { f, page } = await booted("0.32.0");
    page.session.dispose();
    await f.world.advance(DEFAULT_CONFIG.compatRetryMaxMs * 3);
    expect(healthCount(f)).toBe(1);
  });
});

describe("one check in flight", () => {
  test("a reconnect during a check asks exactly once more after it, and the later answer stands", async () => {
    const { f, page } = await booted("0.31.0");
    f.server.addRule({
      match: (r) => r.path === "/health",
      delay: "unbounded",
      times: 1,
    });
    page.session.recheckCompatibility();
    await f.settle();
    expect(healthCount(f)).toBe(2);
    // The server is upgraded while the first answer (taken before the upgrade) is on its way.
    f.server.apiVersion = "0.32.0";
    page.goOffline();
    page.goOnline();
    page.goOffline();
    page.goOnline();
    await f.settle();
    // Nothing more is sent while one is in flight.
    expect(healthCount(f)).toBe(2);
    f.world.release();
    await f.world.runUntilIdle();
    // Exactly one more, asked after the reconnects.
    expect(healthCount(f)).toBe(3);
    expect(page.session.compat.get()).toMatchObject({
      status: "unsupported",
    });
  });

  test("a return to the page while a check is in flight asks nothing more", async () => {
    const { f, page } = await booted("0.31.0");
    await f.world.advance(DEFAULT_CONFIG.compatRecheckMinIntervalMs);
    f.server.addRule({
      match: (r) => r.path === "/health",
      delay: "unbounded",
      times: 1,
    });
    page.env.emit("focus");
    await f.settle();
    expect(healthCount(f)).toBe(2);
    page.env.emit("visible");
    page.env.emit("pageshow");
    f.world.release();
    await f.world.runUntilIdle();
    expect(healthCount(f)).toBe(2);
  });
});

/**
 * WEB-14a revision 1, R1: a reconnect admits no queued write until the check asked AFTER it has answered. The fact turns `unknown` in the
 * same synchronous step as the `online` event (a dispatcher reads it before it issues anything), an answer to a check asked before the
 * reconnect is dropped, and only the fresh answer can make it `supported` again.
 */
describe("a reconnect admits nothing until its own answer (R1)", () => {
  const statuses = (page: {
    session: {
      compat: {
        get(): { status: string };
        subscribe(l: () => void): () => void;
      };
    };
  }) => {
    const seen: string[] = [];
    page.session.compat.subscribe(() =>
      seen.push(page.session.compat.get().status),
    );
    return seen;
  };

  test.each([
    ["matching", "0.31.0", "supported"],
    ["mismatched", "0.32.0", "unsupported"],
    ["missing", null, "missing"],
  ] as const)(
    "%s answer: `supported` is withdrawn at the online event and only the fresh answer decides",
    async (_name, version, final) => {
      const { f, page } = await booted("0.31.0");
      expect(page.session.compat.get().status).toBe("supported");
      page.goOffline();
      await f.settle();
      f.server.apiVersion = version ?? undefined;
      f.server.addRule({
        match: (r) => r.path === "/health",
        delay: "unbounded",
        times: 1,
      });
      const seen = statuses(page);
      page.goOnline();
      // Synchronously, before anything else could run: no write is admitted any more.
      expect(page.session.compat.get()).toEqual({ status: "unknown" });
      await f.settle();
      expect(healthCount(f)).toBe(2);
      expect(page.session.compat.get()).toEqual({ status: "unknown" });
      f.world.release();
      await f.world.runUntilIdle();
      expect(page.session.compat.get().status).toBe(final);
      expect(seen).toEqual(["unknown", final]);
    },
  );

  test("an answer asked BEFORE the reconnect is dropped, even a matching one; the rerun asked after it decides", async () => {
    const { f, page } = await booted("0.31.0");
    f.server.addRule({
      match: (r) => r.path === "/health",
      delay: "unbounded",
      times: 1,
    });
    page.session.recheckCompatibility();
    await f.settle();
    expect(healthCount(f)).toBe(2);
    // The answer on its way says `supported` (the server before the upgrade); the server is upgraded and the page reconnects meanwhile.
    page.goOffline();
    page.goOnline();
    f.server.apiVersion = "0.32.0";
    f.server.addRule({
      match: (r) => r.path === "/health",
      delay: "unbounded",
      times: 1,
    });
    const seen = statuses(page);
    f.world.release();
    await f.world.runUntilIdle();
    // The stale `supported` was not applied: the rerun is still held, and the fact is still `unknown`.
    expect(healthCount(f)).toBe(3);
    expect(page.session.compat.get()).toEqual({ status: "unknown" });
    expect(seen).toEqual([]);
    f.world.release();
    await f.world.runUntilIdle();
    expect(page.session.compat.get()).toMatchObject({
      status: "unsupported",
      version: "0.32.0",
    });
    expect(seen).toEqual(["unsupported"]);
  });

  test("a second reconnect while the first one's check is in flight drops that check's answer too", async () => {
    const { f, page } = await booted("0.31.0");
    page.goOffline();
    f.server.addRule({
      match: (r) => r.path === "/health",
      delay: "unbounded",
      times: 2,
    });
    page.goOnline();
    await f.settle();
    expect(healthCount(f)).toBe(2);
    page.goOffline();
    page.goOnline();
    const seen = statuses(page);
    f.world.release();
    await f.world.runUntilIdle();
    expect(healthCount(f)).toBe(3);
    expect(page.session.compat.get()).toEqual({ status: "unknown" });
    f.world.release();
    await f.world.runUntilIdle();
    expect(page.session.compat.get().status).toBe("supported");
    expect(seen).toEqual(["supported"]);
  });

  test("a pause is not lifted by a reconnect: it stays until the fresh answer", async () => {
    const { f, page } = await booted("0.32.0");
    expect(page.session.compat.get().status).toBe("unsupported");
    page.goOffline();
    await f.settle();
    f.server.apiVersion = "0.31.0";
    f.server.addRule({
      match: (r) => r.path === "/health",
      delay: "unbounded",
      times: 1,
    });
    const seen = statuses(page);
    page.goOnline();
    await f.settle();
    expect(page.session.compat.get().status).toBe("unsupported");
    f.world.release();
    await f.world.runUntilIdle();
    expect(page.session.compat.get().status).toBe("supported");
    expect(seen).toEqual(["supported"]);
  });
});
