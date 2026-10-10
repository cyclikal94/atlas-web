import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DataRuntime } from "../../src/data/engine/account-service";
import { type BrowserComposition, DataProvider } from "../../src/data/ui/react";
import { sessionDouble } from "../helpers/session-double";
import {
  A,
  B,
  type Gate,
  gate,
  type Holds,
  type PendingWorld,
  setup,
} from "../support/data/pending-open";

/**
 * R35 (revision 20), through the PRODUCTION provider and controller: unmounting a `DataProvider` while its runtime's database open is
 * pending must leave nothing behind when that open finishes. The review reproduced it with the real provider, `createBrowserRuntime`
 * and real IndexedDB in three engines (`fixture.data-runtime-lifetime.spec.ts` is that, kept); this is the same lifecycle with the
 * production `DataProvider`, `createProductionEnv`, `createDataEnv` (the controller that looks for the database and binds it) and
 * `DataRuntime` over the double of IndexedDB, so the WIRING (the unmount reaching the runtime, the opener being told, the controller's own
 * post-open check returning without releasing anything) is exercised and not only the runtime on its own. The composition stands for Dexie
 * and the registry, as in `provider-runtime-lifetime.test.tsx`: it builds one runtime per call exactly as `createBrowserRuntime` does and
 * disposes it with the lifetime that asked for it.
 */
function composition(f: PendingWorld) {
  const runtimes: DataRuntime[] = [];
  const loadBrowser = async (): Promise<BrowserComposition> => ({
    createBrowserRuntime: () => {
      const runtime = f.runtime();
      runtimes.push(runtime);
      return {
        runtime,
        channel: { post: () => undefined, subscribe: () => () => undefined },
        dispose: () => runtime.dispose(),
      } as never;
    },
  });
  return { loadBrowser, runtimes };
}

const tree = (
  f: PendingWorld,
  c: ReturnType<typeof composition>,
): ReactElement => (
  <DataProvider
    session={sessionDouble({}, { identity: f.identity })}
    loadBrowser={c.loadBrowser}
  >
    <div />
  </DataProvider>
);

beforeEach(() => {
  // Offline: the readers that follow the identity wait, and nothing asks the network.
  Object.defineProperty(navigator, "onLine", {
    value: false,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
});

const settle = (ms = 30) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/** Lets the released open finish, wherever it was held, then lets the controller and the world run to quiet. */
const afterRelease = async (f: PendingWorld) => {
  await settle();
  await f.world.settle();
  await settle();
};

const NOTHING = {
  connections: 0,
  service: false,
  published: 0,
  latch: "open",
} as const;

const PHASES = [
  {
    name: "the discovery of the databases is pending",
    holds: (g: Gate): Holds => ({ listing: { 1: g } }),
  },
  {
    name: "the native open has finished in the engine and its completion has not been delivered",
    holds: (g: Gate): Holds => ({ landed: { 1: g } }),
  },
] as const;

describe("R35: the production provider, unmounted while its runtime's open is pending", () => {
  test("control: a provider that stays mounted binds the database (two connections), and the unmount closes them", async () => {
    const f = await setup();
    const c = composition(f);
    const view = render(tree(f, c));
    await settle();
    await f.world.settle();
    await settle();
    expect(c.runtimes).toHaveLength(1);
    expect(f.page.registry.openCount(A)).toBe(2);
    expect(c.runtimes[0]?.serviceFor(A)?.live).toBe(true);
    view.unmount();
    expect(f.page.registry.openCount(A)).toBe(0);
    expect(c.runtimes[0]?.serviceFor(A)).toBeNull();
    expect(f.identity.listenerCount).toBe(0);
  });

  for (const phase of PHASES) {
    test(`control, ${phase.name}: an identity change before the open is released, the provider still mounted, refuses the open and latches the account for the identity`, async () => {
      const g = gate();
      const f = await setup({ holds: phase.holds(g) });
      const c = composition(f);
      const view = render(tree(f, c));
      await act(async () => {
        await g.reached;
      });
      f.page.identity.account = B;
      act(() => f.identity.set({ account_id: B, epoch: 2, session_id: "s2" }));
      g.release();
      await afterRelease(f);
      expect(f.page.registry.openCount(A)).toBe(0);
      expect(f.page.registry.latch(A)).toBe("closed_for_identity");
      expect(c.runtimes[0]?.serviceFor(A)).toBeNull();
      view.unmount();
    });

    test(`${phase.name}: the unmount disposes the runtime, so the late completion installs no service, publishes no epoch and keeps no connection, and a later identity change finds nothing`, async () => {
      const g = gate();
      const f = await setup({ holds: phase.holds(g) });
      const c = composition(f);
      const view = render(tree(f, c));
      await act(async () => {
        await g.reached;
      });
      view.unmount();
      g.release();
      await afterRelease(f);
      const old = c.runtimes[0];
      if (old === undefined) throw new Error("no runtime was built");
      expect(f.held(old)).toEqual(NOTHING);
      expect(f.identity.listenerCount).toBe(0);
      // The identity leaves the account afterwards: nothing is left to close, and nothing follows it.
      f.page.identity.account = B;
      act(() => f.identity.set({ account_id: B, epoch: 2, session_id: "s2" }));
      await afterRelease(f);
      expect(f.held(old)).toEqual(NOTHING);
      // Nothing asked for another runtime, and nothing looks again for a database the unmounted provider will never open.
      await settle(60);
      expect(c.runtimes).toHaveLength(1);
    });

    test(`${phase.name}, and the tree is mounted AGAIN before the late completion (a remount, or a restarted provider): the replacement's connections and service are untouched`, async () => {
      const g = gate();
      const f = await setup({ holds: phase.holds(g) });
      const c = composition(f);
      const first = render(tree(f, c));
      await act(async () => {
        await g.reached;
      });
      first.unmount();
      const second = render(tree(f, c));
      await settle();
      await f.world.settle();
      await settle();
      expect(c.runtimes).toHaveLength(2);
      expect(c.runtimes[1]?.serviceFor(A)?.live).toBe(true);
      g.release();
      await afterRelease(f);
      // Exactly the replacement's own two connections: the late completion of the old lifetime closed none of them and latched nothing.
      expect(f.page.registry.openCount(A)).toBe(2);
      expect(f.page.registry.latch(A)).toBe("open");
      expect(c.runtimes[1]?.serviceFor(A)?.live).toBe(true);
      expect(c.runtimes[0]?.serviceFor(A)).toBeNull();
      second.unmount();
      expect(f.page.registry.openCount(A)).toBe(0);
      expect(f.identity.listenerCount).toBe(0);
    });
  }
});
