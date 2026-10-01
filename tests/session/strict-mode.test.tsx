import { cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionRoot } from "../../src/app/SessionRoot";
import { SessionProvider } from "../../src/session";
import { sessionDouble } from "../helpers/session-double";
import { Fixture } from "../support/session/harness";

afterEach(cleanup);

/**
 * R-8 (plan 16.4): React 19 StrictMode double-invokes effects, which would double-register page listeners if a component
 * created or started the session. `createSession` and `start()` are called by the composition root, outside any component effect;
 * the UI only subscribes. These tests prove both halves.
 */
describe("StrictMode (R-8)", () => {
  test("mounting the session UI under StrictMode never starts, creates or disposes the session", () => {
    const session = sessionDouble();
    const start = vi.spyOn(session, "start");
    const dispose = vi.spyOn(session, "dispose");
    render(
      <StrictMode>
        <SessionProvider session={session}>
          <SessionRoot />
        </SessionProvider>
      </StrictMode>,
    );
    expect(start).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  test("start() is idempotent: a second call registers no further page listeners, hint subscriptions or scan", async () => {
    const f = new Fixture();
    const page = f.addPage();
    await f.boot(page);
    const listeners = () =>
      (page.env as unknown as { listeners: Map<string, Set<unknown>> })
        .listeners;
    const count = () =>
      [...listeners().values()].reduce((n, set) => n + set.size, 0);
    const before = count();
    expect(before).toBeGreaterThan(0);
    const timers = f.world.pendingCount();
    const again = page.session.start();
    await f.world.runUntilIdle();
    await again;
    expect(count()).toBe(before);
    expect(f.world.pendingCount()).toBe(timers);
  });
});
