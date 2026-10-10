import { act, cleanup, render } from "@testing-library/react";
import { type ReactElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type BrowserComposition, DataProvider } from "../../src/data/ui/react";
import { sessionDouble } from "../helpers/session-double";

/**
 * R29 (revision 13), the part of the lifetime that is ASYNCHRONOUS: the browser runtime is built after a lazy import, so it belongs to
 * the lifetime (start) that asked for it. A runtime that arrives after that lifetime was stopped (an unmount, or the cleanup of a
 * replayed effect) must be disposed at once and never kept, a newer lifetime's must not be disturbed by it, and every runtime built is
 * disposed exactly once when the tree is gone.
 *
 * `DataProvider` takes the lazy load as an optional prop (production leaves the default, the dynamic import), so each test decides WHEN
 * each import arrives and in which order: "cleanup, restart, then the first import resolves" is the schedule under test, not a hope. The
 * composition stands for Dexie and the registry: this is a test of the provider's bookkeeping, and of nothing about a database.
 */
interface Built {
  dispose: ReturnType<typeof vi.fn>;
  runtime: { open: ReturnType<typeof vi.fn> };
}

/** A lazy load whose imports the test resolves by hand, in any order. */
function deferredLoads() {
  const built: Built[] = [];
  const pending: Array<() => void> = [];
  const loadBrowser = vi.fn(
    () =>
      new Promise<BrowserComposition>((resolve) => {
        pending.push(() =>
          resolve({
            createBrowserRuntime: () => {
              const one = {
                runtime: { open: vi.fn(async () => ({ kind: "absent" })) },
                channel: {
                  post: () => undefined,
                  subscribe: () => () => undefined,
                },
                dispose: vi.fn(),
              };
              built.push(one);
              return one as never;
            },
          }),
        );
      }),
  );
  return {
    loadBrowser,
    built,
    /** The imports asked for and not yet resolved. */
    waiting: () => pending.length,
    /** Resolves the n-th import asked for (0 is the first). */
    arrive: (index: number) => pending[index]?.(),
  };
}

const identity = {
  get: () => ({ account_id: "acct", epoch: 1, session_id: "sess" }),
  subscribe: () => () => undefined,
};

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

const tree = (
  loads: ReturnType<typeof deferredLoads>,
  strict: boolean,
): ReactElement => {
  const session = sessionDouble({}, { identity });
  const provider = (
    <DataProvider session={session} loadBrowser={loads.loadBrowser}>
      <div />
    </DataProvider>
  );
  return strict ? <StrictMode>{provider}</StrictMode> : provider;
};

describe("a runtime built after its lifetime ended is never kept", () => {
  for (const order of [
    { name: "in order", first: 0, second: 1 },
    { name: "reversed", first: 1, second: 0 },
  ])
    test(`Strict Mode, the two imports arriving ${order.name}: the first lifetime's runtime is disposed on arrival, the second's is kept and disposed by the unmount`, async () => {
      const loads = deferredLoads();
      const view = render(tree(loads, true));
      // Both lifetimes (the effect, its cleanup, its replay) have asked; neither import has arrived.
      expect(loads.waiting()).toBe(2);
      expect(loads.built).toHaveLength(0);
      loads.arrive(order.first);
      await settle();
      loads.arrive(order.second);
      await settle();
      expect(loads.built).toHaveLength(2);
      // The import of the FIRST lifetime is index 0: whichever arrived when, that lifetime was stopped before it, so its runtime is
      // the one disposed at once; the second lifetime's stands.
      const arrived = loads.built;
      const [stale, live] =
        order.first === 0 ? arrived : [arrived[1], arrived[0]];
      expect(stale?.dispose).toHaveBeenCalledTimes(1);
      expect(live?.dispose).not.toHaveBeenCalled();
      view.unmount();
      expect(live?.dispose).toHaveBeenCalledTimes(1);
      expect(stale?.dispose).toHaveBeenCalledTimes(1);
      // Nothing is asked for again by the lifetime that ended (no paced look at a database it will never open).
      await settle(60);
      expect(loads.loadBrowser).toHaveBeenCalledTimes(2);
      expect(loads.built).toHaveLength(2);
    });

  test("a plain mount: one runtime, kept while mounted, disposed once on unmount", async () => {
    const loads = deferredLoads();
    const view = render(tree(loads, false));
    expect(loads.waiting()).toBe(1);
    loads.arrive(0);
    await settle();
    expect(loads.built).toHaveLength(1);
    expect(loads.built[0]?.dispose).not.toHaveBeenCalled();
    view.unmount();
    expect(loads.built[0]?.dispose).toHaveBeenCalledTimes(1);
    await settle(60);
    expect(loads.loadBrowser).toHaveBeenCalledTimes(1);
  });

  test("an unmount BEFORE the import arrives: the runtime that arrives later is disposed at once, and nothing keeps it", async () => {
    const loads = deferredLoads();
    const view = render(tree(loads, false));
    view.unmount();
    loads.arrive(0);
    await settle();
    expect(loads.built).toHaveLength(1);
    expect(loads.built[0]?.dispose).toHaveBeenCalledTimes(1);
    await settle(60);
    expect(loads.loadBrowser).toHaveBeenCalledTimes(1);
    expect(loads.built).toHaveLength(1);
  });

  test("every runtime built is disposed exactly once by the time the tree is gone, however many times it was mounted", async () => {
    const all: Built[] = [];
    for (let i = 0; i < 4; i += 1) {
      const loads = deferredLoads();
      const view = render(tree(loads, true));
      for (let n = 0; n < loads.waiting(); n += 1) loads.arrive(n);
      await settle();
      view.unmount();
      await settle();
      all.push(...loads.built);
    }
    expect(all.length).toBeGreaterThan(0);
    for (const one of all) expect(one.dispose).toHaveBeenCalledTimes(1);
  });
});
