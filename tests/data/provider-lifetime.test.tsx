import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProtectedProviders } from "../../src/app/providers";
import { createDataEnv, type DataEnv } from "../../src/data/ui/env";
import { DataProvider, useDataEnv } from "../../src/data/ui/react";
import { installMatchMedia } from "../helpers/match-media";
import { sessionDouble } from "../helpers/session-double";

/**
 * R29 (revision 13): the production data provider leaks controllers under development Strict Mode.
 *
 * `useState(() => createProductionEnv(session))` built an ACTIVE controller in render: it started the identity readers and registered
 * its subscriptions. Strict Mode calls a state initialiser twice and keeps one, so the discarded controller subscribed and nothing ever
 * disposed it; and in a root Strict Mode mount the effect's replay disposed the retained controller for good, because nothing started
 * it again, leaving the visible one stopped (its online state stuck). The reviewer's probe: four identity subscriptions left after
 * unmount, and online state stuck at `true`.
 *
 * The rule: construction is inert; the controller starts in the effect and stops in its cleanup, a PAIR that React may replay; and
 * everything a lifetime opened (identity subscriptions, window listeners, the `atlas-sync` channel) is released by its stop. These tests
 * run the PRODUCTION provider (`DataProvider`, and `ProtectedProviders`, which wraps in Strict Mode), counting what is live.
 */
installMatchMedia({ width: 1440 });

/** An identity store that counts its live subscriptions (the reviewer's observable). */
function observableIdentity(signedIn = false) {
  const listeners = new Set<() => void>();
  return {
    listeners,
    store: {
      get: () =>
        signedIn ? { account_id: "acct", epoch: 1, session_id: "sess" } : null,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}

/** Every `atlas-sync` channel the page opened, and whether it was closed. */
class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: unknown = null;
  closed = false;
  constructor(readonly name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(): void {}
  close(): void {
    this.closed = true;
  }
  static live(): number {
    return FakeChannel.all.filter((channel) => !channel.closed).length;
  }
}

/** The window listeners of the types this layer uses, as added and not yet removed. */
function windowListeners() {
  const live = new Map<string, Set<unknown>>();
  const types = new Set(["online", "offline", "storage"]);
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(
    (type: string, listener: unknown, options?: unknown) => {
      if (types.has(type)) {
        const set = live.get(type) ?? new Set();
        set.add(listener);
        live.set(type, set);
      }
      add(type, listener as never, options as never);
    },
  );
  vi.spyOn(window, "removeEventListener").mockImplementation(
    (type: string, listener: unknown, options?: unknown) => {
      live.get(type)?.delete(listener);
      remove(type, listener as never, options as never);
    },
  );
  return () =>
    Object.fromEntries(
      [...types].sort().map((type) => [type, live.get(type)?.size ?? 0]),
    );
}

beforeEach(() => {
  FakeChannel.all = [];
  vi.stubGlobal("BroadcastChannel", FakeChannel);
});

afterEach(() => {
  cleanup();
  // Mocks first, then the timers (vitest 5): the other order reinstalls a dead fake.
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
});

type Wrapper = "plain" | "root-strict" | "protected-providers";
const WRAPPERS: Wrapper[] = ["plain", "root-strict", "protected-providers"];

function mount(wrapper: Wrapper) {
  const identity = observableIdentity();
  const session = sessionDouble({}, { identity: identity.store });
  let env: DataEnv | null = null;
  function Probe() {
    env = useDataEnv();
    return null;
  }
  const child = (
    <DataProvider session={session}>
      <Probe />
    </DataProvider>
  );
  const view = render(
    wrapper === "plain" ? (
      child
    ) : wrapper === "root-strict" ? (
      <StrictMode>{child}</StrictMode>
    ) : (
      <ProtectedProviders>{child}</ProtectedProviders>
    ),
  );
  return { identity, view, env: () => env as DataEnv };
}

const goOffline = () =>
  act(async () => {
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    window.dispatchEvent(new Event("offline"));
  });
const goOnline = () =>
  act(async () => {
    Object.defineProperty(navigator, "onLine", {
      value: true,
      configurable: true,
    });
    window.dispatchEvent(new Event("online"));
  });

describe("the production provider, mounted in each way the application can mount it", () => {
  for (const wrapper of WRAPPERS) {
    test(`${wrapper}: the visible controller is LIVE (it follows connectivity), and unmounting leaves no subscription, listener or channel`, async () => {
      const listeners = windowListeners();
      const { identity, view, env } = mount(wrapper);
      expect(env().inputs.get().online).toBe(true);
      await goOffline();
      expect(env().inputs.get().online).toBe(false);
      await goOnline();
      expect(env().inputs.get().online).toBe(true);
      expect(identity.listeners.size).toBeGreaterThan(0);
      view.unmount();
      expect(identity.listeners.size).toBe(0);
      expect(listeners()).toEqual({ offline: 0, online: 0, storage: 0 });
      expect(FakeChannel.live()).toBe(0);
    });
  }

  test("a Strict Mode mount holds exactly what a plain mount holds: nothing is doubled, nothing is missing", async () => {
    // What `ProtectedProviders` itself listens to (its theme and announcer) is not the data layer's: it is measured on its own and taken off.
    const aloneListeners = windowListeners();
    const alone = render(
      <ProtectedProviders>
        <div />
      </ProtectedProviders>,
    );
    const baseline = aloneListeners();
    alone.unmount();
    cleanup();
    vi.restoreAllMocks();
    FakeChannel.all = [];

    const held: Record<
      string,
      { identity: number; window: Record<string, number>; channels: number }
    > = {};
    for (const wrapper of WRAPPERS) {
      const listeners = windowListeners();
      const { identity, view } = mount(wrapper);
      held[wrapper] = {
        identity: identity.listeners.size,
        window: listeners(),
        channels: FakeChannel.live(),
      };
      view.unmount();
      cleanup();
      vi.restoreAllMocks();
      FakeChannel.all = [];
    }
    const plain = held.plain as (typeof held)[string];
    expect(held["root-strict"]).toEqual(plain);
    const protectedData = held["protected-providers"] as (typeof held)[string];
    expect(protectedData.identity).toBe(plain.identity);
    expect(protectedData.channels).toBe(plain.channels);
    for (const [type, count] of Object.entries(plain.window))
      expect(protectedData.window[type], type).toBe(
        count + (baseline[type] ?? 0),
      );
    expect(plain.identity).toBeGreaterThan(0);
    expect(plain.channels).toBe(1);
  });

  test("construction alone holds nothing: a controller that React discards is never started", () => {
    const identity = observableIdentity();
    const session = sessionDouble({}, { identity: identity.store });
    const channelsBefore = FakeChannel.all.length;
    // The provider's state initialiser, run and dropped without an effect: what React does with the first of two renders.
    let built: DataEnv | null = null;
    function Capture() {
      built = useDataEnv();
      return null;
    }
    const view = render(
      <DataProvider session={session}>
        <Capture />
      </DataProvider>,
    );
    view.unmount();
    expect(built).not.toBeNull();
    expect(identity.listeners.size).toBe(0);
    // Every channel it opened was closed with it, and only a started controller opens one.
    expect(FakeChannel.live()).toBe(0);
    expect(FakeChannel.all.length).toBeGreaterThanOrEqual(channelsBefore);
  });

  test("mounting and unmounting again and again leaves no growth: five cycles, nothing live after each", async () => {
    const listeners = windowListeners();
    for (const wrapper of [...WRAPPERS, ...WRAPPERS]) {
      const { identity, view } = mount(wrapper);
      view.unmount();
      expect(identity.listeners.size, wrapper).toBe(0);
      expect(listeners(), wrapper).toEqual({
        offline: 0,
        online: 0,
        storage: 0,
      });
      expect(FakeChannel.live(), wrapper).toBe(0);
    }
  });

  test("a connectivity change while the effect is between its cleanup and its restart is not lost", async () => {
    // Strict Mode replays the effect: the controller is stopped and started with nothing listening in between. Whatever happened to
    // connectivity meanwhile is read again when it starts.
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    const { env, view } = mount("root-strict");
    expect(env().inputs.get().online).toBe(false);
    view.unmount();
  });
});

describe("the controller is a start and stop PAIR, and either may repeat", () => {
  function build(start: boolean, signedIn = false) {
    const identity = observableIdentity(signedIn);
    const onlineListeners = new Set<() => void>();
    let onlineValue = true;
    const onOnline = new Set<() => void>();
    const env = createDataEnv(
      {
        identity: identity.store,
        loadRuntime: () => Promise.reject(new Error("not loaded")),
        online: {
          get: () => onlineValue,
          subscribe: (listener) => {
            onlineListeners.add(listener);
            return () => {
              onlineListeners.delete(listener);
            };
          },
        },
        quota: {
          check: async () => "ok",
          reserve: async () => ({
            verdict: "ok",
            live: () => true,
            settle: () => undefined,
          }),
          lastFree: () => null,
          invalidate: () => undefined,
        },
        ids: { uuid: () => "id" },
        clock: { iso: () => "", now: () => 0 },
        fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
        readMe: async () =>
          ({ kind: "unavailable", reason: "no_answer" }) as never,
        currentDeviceId: async () => ({ kind: "unavailable" }) as never,
        onOnline: (listener) => {
          onOnline.add(listener);
          return () => {
            onOnline.delete(listener);
          };
        },
      },
      { start },
    );
    return {
      env,
      identity,
      online: {
        listeners: onlineListeners,
        set: (value: boolean) => {
          onlineValue = value;
          for (const listener of [...onlineListeners]) listener();
        },
        raw: () => onlineValue,
        flip: (value: boolean) => {
          onlineValue = value;
        },
      },
      onOnline,
    };
  }

  test("`start: false` subscribes to nothing until `start()` is called", () => {
    const w = build(false);
    expect(w.identity.listeners.size).toBe(0);
    expect(w.online.listeners.size).toBe(0);
    expect(w.onOnline.size).toBe(0);
    w.env.start();
    expect(w.identity.listeners.size).toBeGreaterThan(0);
    expect(w.online.listeners.size).toBeGreaterThan(0);
    expect(w.onOnline.size).toBeGreaterThan(0);
    w.env.dispose();
    expect(w.identity.listeners.size).toBe(0);
    expect(w.online.listeners.size).toBe(0);
    expect(w.onOnline.size).toBe(0);
  });

  test("the default starts at once (a caller that owns the controller, as every test and the fixture do)", () => {
    const w = build(true);
    expect(w.identity.listeners.size).toBeGreaterThan(0);
    w.env.dispose();
    expect(w.identity.listeners.size).toBe(0);
  });

  test("`start()` is idempotent: a second call adds nothing", () => {
    const w = build(false);
    w.env.start();
    const once = [
      w.identity.listeners.size,
      w.online.listeners.size,
      w.onOnline.size,
    ];
    w.env.start();
    w.env.start();
    expect([
      w.identity.listeners.size,
      w.online.listeners.size,
      w.onOnline.size,
    ]).toEqual(once);
    w.env.dispose();
  });

  test("`dispose()` is idempotent and releases everything", () => {
    const w = build(true);
    w.env.dispose();
    w.env.dispose();
    expect(w.identity.listeners.size).toBe(0);
    expect(w.online.listeners.size).toBe(0);
    expect(w.onOnline.size).toBe(0);
  });

  test("a stopped controller starts again from the world as it is now: the replay of an effect leaves it live, and connectivity is current", () => {
    const w = build(false);
    w.env.start();
    const held = [
      w.identity.listeners.size,
      w.online.listeners.size,
      w.onOnline.size,
    ];
    w.env.dispose();
    expect(w.identity.listeners.size).toBe(0);
    // Connectivity moves while nothing listens.
    w.online.flip(false);
    expect(w.env.inputs.get().online).toBe(true);
    w.env.start();
    expect([
      w.identity.listeners.size,
      w.online.listeners.size,
      w.onOnline.size,
    ]).toEqual(held);
    // It reads connectivity again at its start, and follows it afterwards.
    expect(w.env.inputs.get().online).toBe(false);
    w.online.set(true);
    expect(w.env.inputs.get().online).toBe(true);
    w.env.dispose();
  });

  test("a restart reads connectivity again even while a database is being looked for (signed in): what changed while nothing listened is not left stale", () => {
    const w = build(false, true);
    w.env.start();
    w.env.dispose();
    w.online.flip(false);
    w.env.start();
    // Read at the start itself, before anything the look might later publish.
    expect(w.env.inputs.get().online).toBe(false);
    w.env.dispose();
  });

  test("many stop-start pairs hold exactly what one start holds", () => {
    const w = build(false);
    w.env.start();
    const held = [
      w.identity.listeners.size,
      w.online.listeners.size,
      w.onOnline.size,
    ];
    for (let i = 0; i < 10; i += 1) {
      w.env.dispose();
      w.env.start();
    }
    expect([
      w.identity.listeners.size,
      w.online.listeners.size,
      w.onOnline.size,
    ]).toEqual(held);
    w.env.dispose();
    expect(w.identity.listeners.size).toBe(0);
  });
});

describe("the runtime a controller loads belongs to the lifetime that asked for it", () => {
  /** A controller over a signed-in identity whose lazy runtime load is decided by the test. */
  function loading() {
    const loads: Array<{
      resolve(runtime: unknown): void;
      reject(error: Error): void;
    }> = [];
    const identity = {
      get: () => ({ account_id: "acct", epoch: 1, session_id: "sess" }),
      subscribe: () => () => undefined,
    };
    const loadRuntime = vi.fn(
      () =>
        new Promise<never>((resolve, reject) => {
          loads.push({
            resolve: resolve as (runtime: unknown) => void,
            reject,
          });
        }),
    );
    const env = createDataEnv(
      {
        identity,
        loadRuntime,
        online: { get: () => false, subscribe: () => () => undefined },
        quota: {
          check: async () => "ok",
          reserve: async () => ({
            verdict: "ok",
            live: () => true,
            settle: () => undefined,
          }),
          lastFree: () => null,
          invalidate: () => undefined,
        },
        ids: { uuid: () => "id" },
        clock: { iso: () => "", now: () => 0 },
        fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
        readMe: async () => ({ kind: "unavailable" }) as never,
        currentDeviceId: async () => ({ kind: "unavailable" }) as never,
        onOnline: () => () => undefined,
      },
      { start: false },
    );
    return { env, loads, loadRuntime };
  }

  test("a restart loads a runtime of its own: the memo of the one a stop left behind is not reused", () => {
    const w = loading();
    w.env.start();
    expect(w.loadRuntime).toHaveBeenCalledTimes(1);
    w.env.dispose();
    w.env.start();
    expect(w.loadRuntime).toHaveBeenCalledTimes(2);
    w.env.dispose();
  });

  test("a load that fails AFTER a restart began its own does not erase it: the next ask still finds the newer load", async () => {
    const w = loading();
    w.env.start();
    w.env.dispose();
    w.env.start();
    expect(w.loadRuntime).toHaveBeenCalledTimes(2);
    // The first lifetime's load fails now, while the second's is still pending.
    w.loads[0]?.reject(new Error("the first lifetime's load failed"));
    await act(async () => {
      await Promise.resolve();
    });
    // "Try again" asks for the runtime: the pending second load is the one it finds, and no third is started.
    w.env.actions.retryLoad();
    expect(w.loadRuntime).toHaveBeenCalledTimes(2);
    w.env.dispose();
  });

  test("a runtime that arrives for a stopped lifetime is never opened or used, and says nothing of the lifetime that stands", async () => {
    const w = loading();
    w.env.start();
    w.env.dispose();
    const stale = { open: vi.fn(async () => ({ kind: "absent" })) };
    w.loads[0]?.resolve(stale);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(stale.open).not.toHaveBeenCalled();
    expect(w.env.queue.get()).toEqual({
      status: "unavailable",
      reason: "absent",
    });
  });

  test("the newer lifetime's runtime is the one that is opened", async () => {
    const w = loading();
    w.env.start();
    w.env.dispose();
    w.env.start();
    const live = { open: vi.fn(async () => ({ kind: "absent" })) };
    w.loads[1]?.resolve(live);
    await vi.waitFor(() => expect(live.open).toHaveBeenCalledTimes(1));
    w.env.dispose();
  });
});
