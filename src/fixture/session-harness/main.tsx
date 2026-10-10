import { type Booted, boot } from "../../app/boot";
import { getPageDataHost } from "../../data";
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
 * directly without a session's own activity interfering. `?boot=manual` loads the page and exposes everything but starts the session only
 * when the test calls `start()` (R34, revision 19): a test that injects a fault into the live page (`indexedDB.open` of the account's
 * database, the listing of databases) can then install it, CHECK that it is in force, and only then let the application run, instead of
 * trusting a context-level init script to have run before the application's first request (a WebKit page was found, in the failures of
 * revisions 17 and 18, to have bound a database whose opens were to fail, with no way to tell afterwards whether the script ever ran).
 */
export interface SessionHarness {
  /** Resolves when the boot sequence has finished (null: the compatibility screen replaced the app). */
  ready: Promise<Booted | null>;
  booted: Booted | null;
  /**
   * Starts the session on a `?boot=manual` page (once; later calls answer `ready`). On any other page the session either started at
   * load or, with `?boot=off`, is never started, and this answers `ready` as it stands.
   */
  start(): Promise<Booted | null>;
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
  /** Write any of the `atlas-auth` records directly (for example a `pending_deletions` entry another visit left behind). */
  seedRecords(records: Record<string, unknown>): Promise<void>;
  readRecords(): Promise<unknown>;
  /**
   * FIXTURE ONLY (WEB-09b): what the PRODUCTION leader of this page is doing (`?leader=production`), read from the page host the
   * provider also reads: the election's role, the attachment, the engine's and the recovery job's states, the job's exclusivity and its
   * Q24 notice. A content-free snapshot for the native specs; it changes nothing.
   */
  leader(): {
    role: string;
    attachment: string;
    engine: unknown;
    job: unknown;
    exclusive: boolean | null;
    notice: unknown;
  };
  /** FIXTURE ONLY: the job's own retry ("Try again" / "Retry applying changes"), as the screens call it. */
  leaderRetry(): void;
  /** FIXTURE ONLY: the production engine looks now (its own `nudge`), so a test need not wait for the live-edge poll. */
  leaderNudge(): void;
  /**
   * FIXTURE ONLY (WEB-09b, R7 of the review of 10 October 2026, second cycle): WF-QUEUE-02's authorised current read of a draft, made by
   * the PRODUCTION controller (`createDataEnv`) over this page's booted session (its real ordinary `fetchFor` and `seal`) and the page
   * runtime the production leader composed. No production command kind registers a read yet, so the read is a TEST-ONLY kind (`note`,
   * the native drafts' kind) in a private registry: `GET /tasks/<local id>`, its body decoded, then, while `window.__currentReadHold` is
   * true, its LATER interpretation held until the test sets it false (`window.__currentReadHeld` says it is held). The result is the
   * controller's, unchanged.
   */
  currentRead(localId: string): Promise<unknown>;
}

const params = new URLSearchParams(location.search);
const off = params.get("boot") === "off";
const manual = params.get("boot") === "manual";
// The protected tree routes on the browser location; start it on the route the test asks for (default: Today). The URL fragment
// is KEPT: boot's first statement reads and strips it (an OIDC grant, an invitation token), exactly as in production.
history.replaceState(
  null,
  "",
  (params.get("route") ?? "/today") + location.hash,
);
const neutralRoot = document.getElementById("neutral-root");
if (!neutralRoot) throw new Error("Missing neutral root");

const harness: SessionHarness = {
  ready: Promise.resolve(null),
  booted: null,
  start: () => {
    if (manual && !startedByTest) startedByTest = startBoot();
    return harness.ready;
  },
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
  async seedRecords(records) {
    const store: OpenedAuthStore =
      harness.booted?.store ?? (await openAuthStore());
    await store.transact(
      () => ({
        write: records as never,
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
  leader() {
    const attachment = getPageDataHost().leader.get();
    const role = harness.booted?.leader?.role.get().kind ?? "none";
    if (attachment.role !== "leader")
      return {
        role,
        attachment: attachment.role,
        engine: null,
        job: null,
        exclusive: null,
        notice: null,
      };
    return {
      role,
      attachment: "leader",
      engine: attachment.engine.state.get(),
      job: attachment.recovery.state.get(),
      exclusive: attachment.recovery.exclusive.get(),
      notice: attachment.recovery.notice.get(),
    };
  },
  leaderRetry() {
    const attachment = getPageDataHost().leader.get();
    if (attachment.role === "leader") attachment.recovery.retryNow();
  },
  leaderNudge() {
    const attachment = getPageDataHost().leader.get();
    if (attachment.role === "leader") attachment.engine.nudge("now");
  },
  async currentRead(localId) {
    currentReadEnv ??= createCurrentReadEnv();
    const env = await currentReadEnv;
    for (let i = 0; i < 200 && env.service() === null; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 25));
    return env.actions.readCurrent(localId as never);
  },
};

let currentReadEnv: Promise<import("../../data/ui/env").DataEnv> | null = null;
/** The production controller of `currentRead` (built once, on first use; never part of the harness's first chunk). */
async function createCurrentReadEnv() {
  const session = harness.booted?.session;
  if (!session) throw new Error("fixture: the session has not booted");
  const [{ createDataEnv }, { createCommandRegistry }, { apiUrl }] =
    await Promise.all([
      import("../../data/ui/env"),
      import("../../data/outbox/registries"),
      import("../../lib/api-client/wire"),
    ]);
  const host = getPageDataHost();
  const commands = createCommandRegistry();
  const flags = window as unknown as {
    __currentReadHold?: boolean;
    __currentReadHeld?: boolean;
  };
  commands.register("note", {
    describe: () => "A note (test-only kind)",
    readCurrent: async (draft, io) => {
      const response = await io.get(`/tasks/${draft.local_id}`);
      if (response.status === 404)
        return { kind: "failed", reason: "inaccessible" };
      const body = (await response.json()) as {
        label: string;
        version: number;
      };
      flags.__currentReadHeld = flags.__currentReadHold === true;
      while (flags.__currentReadHold === true)
        await new Promise((resolve) => setTimeout(resolve, 10));
      flags.__currentReadHeld = false;
      return {
        kind: "loaded",
        value: {
          id: draft.local_id,
          kind: "task",
          parent_id: null,
          label: body.label,
          value: null,
          version: body.version,
          can_edit: true,
          archived: false,
          kind_date: null,
        } as never,
      };
    },
  });
  return createDataEnv({
    identity: session.identity,
    loadRuntime: () =>
      new Promise((resolve) => {
        const now = host.runtime.get();
        if (now !== null) return resolve(now.runtime);
        const off = host.runtime.subscribe(() => {
          const next = host.runtime.get();
          if (next === null) return;
          off();
          resolve(next.runtime);
        });
      }),
    online: { get: () => navigator.onLine, subscribe: () => () => undefined },
    quota: { check: async () => "admit" } as never,
    ids: { uuid: () => crypto.randomUUID() },
    clock: { now: () => Date.now(), iso: () => new Date().toISOString() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
    readMe: async () => ({ kind: "closed" }),
    currentDeviceId: async () => ({ kind: "closed" }),
    onOnline: () => () => undefined,
    commands,
    fetchOrdinary: (account, epoch) =>
      session.api.fetchFor("ordinary", account, epoch),
    apiUrl: (path) => apiUrl(path),
    seal: (account, epoch, pending) =>
      session.api.seal(account, epoch, pending),
  });
}
// The data harness is attached too, so one page can run the production session AND arrange or inspect real rows in the
// account databases (it shares the page registry the production deletion ports use).
void import("../data-harness/main");
const fixtureHooks = window.__atlasFixture ?? {
  setSync: () => undefined,
  opened: [],
};
window.__atlasFixture = { ...fixtureHooks, session: harness };

// FIXTURE ONLY: the contention measurements scale the session's lock wait so a "closing write gives up" can be observed many times
// (`?lockWaitMs=1000`); the result says it was scaled. Production never sets a session constant.
const scaledLockWait = Number(params.get("lockWaitMs"));
// FIXTURE ONLY (WEB-09b, P-13): the PRODUCTION sync leader runs only when the page asks (`?leader=production`), so the specs that drive
// the data harness's own test leader keep their meaning and two engines never issue `/sync` on one page.
const productionLeader = params.get("leader") === "production";
let startedByTest: Promise<Booted | null> | null = null;
const startBoot = (): Promise<Booted | null> => {
  harness.ready = boot({
    ...(Number.isFinite(scaledLockWait) && scaledLockWait > 0
      ? { config: { lockWaitMs: scaledLockWait } }
      : {}),
    neutralRoot,
    dataLeader: productionLeader,
    trace: {
      emit(event, data) {
        harness.trace.push({ at: Date.now(), event, data });
      },
    },
  }).then((booted) => {
    harness.booted = booted;
    return booted;
  });
  return harness.ready;
};
if (!off && !manual) startBoot();
