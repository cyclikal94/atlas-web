import { type Booted, boot } from "../../app/boot";
import {
  createBroadcastHints,
  createWebLocksPort,
  type HintChannel,
  type LockPort,
  type OpenedAuthStore,
  openAuthStore,
  runAuthCanary,
} from "../../session";

/**
 * FIXTURE ONLY. The session harness: it runs the PRODUCTION composition (`src/app/boot.tsx`, the real IndexedDB store, Web Locks,
 * BroadcastChannel, page and protected-surface adapters) in a real browser engine, with no backend. The network is whatever
 * the test stubs with `page.route`. It exists because there is no production sign-in surface until WEB-08b, and the
 * adapters must be proved in Chromium, Firefox and WebKit, not in a double. It is never packaged (`check-no-fixture`), and a
 * passing run of it is fixture evidence, not integration evidence.
 *
 * `?boot=off` exposes the adapters without starting a session, so a test can drive the store, the locks and the hints
 * directly without a session's own activity interfering.
 */
export interface SessionHarness {
  /** Resolves when the boot sequence has finished (null: the compatibility screen replaced the app). */
  ready: Promise<Booted | null>;
  booted: Booted | null;
  /** A NEW connection to `atlas-auth` in this page (a second connection, as a second tab would have). */
  openStore(): Promise<OpenedAuthStore>;
  locks: LockPort;
  hints(): HintChannel;
  /** The boot canary, against a store connection. */
  canary(store: OpenedAuthStore): Promise<boolean>;
  /** The kernel's trace in this page (test instrumentation; production uses the no-op trace). */
  trace: Array<{ at: number; event: string; data?: Record<string, unknown> }>;
  /** Write `auth_state` directly (a settled account, a fence) through the production store. */
  seedAuthState(state: unknown): Promise<void>;
  readRecords(): Promise<unknown>;
}

const params = new URLSearchParams(location.search);
const off = params.get("boot") === "off";
// The protected tree routes on the browser location; start it on the route the test asks for (default: Today).
history.replaceState(null, "", params.get("route") ?? "/today");
const neutralRoot = document.getElementById("neutral-root");
if (!neutralRoot) throw new Error("Missing neutral root");

const harness: SessionHarness = {
  ready: Promise.resolve(null),
  booted: null,
  openStore: () => openAuthStore(),
  locks: createWebLocksPort(navigator.locks),
  hints: () => createBroadcastHints(),
  canary: (store) => runAuthCanary(store),
  trace: [],
  async seedAuthState(state) {
    const store: OpenedAuthStore =
      harness.booted?.store ?? (await openAuthStore());
    await store.transact(
      () => ({
        write: { auth_state: state as never },
        result: null,
      }),
      { durability: "strict", label: "seed" },
    ).complete;
  },
  async readRecords() {
    const store: OpenedAuthStore =
      harness.booted?.store ?? (await openAuthStore());
    return store.transact((records) => ({
      write: null,
      result: structuredClone(records),
    })).complete;
  },
};
const fixtureHooks = window.__atlasFixture ?? {
  setSync: () => undefined,
  opened: [],
};
window.__atlasFixture = { ...fixtureHooks, session: harness };

if (!off) {
  harness.ready = boot({
    neutralRoot,
    trace: {
      emit(event, data) {
        harness.trace.push({ at: Date.now(), event, data });
      },
    },
  }).then((booted) => {
    harness.booted = booted;
    return booted;
  });
}
