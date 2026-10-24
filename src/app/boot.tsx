import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
// A named import, so the bundler keeps the version and drops the rest (the release URL must not ship in the client).
import { version as contractVersion } from "../../contract-pin.json";
import { liveRegions } from "../components/ui/announcer";
import { createGateDialog } from "../components/ui/gate-dialog";
import { NeutralGate } from "../components/ui/neutral-gate";
import { createDataDeletionPorts } from "../data";
import { ThemeProvider } from "../design/ThemeProvider";
import type { completeLanding } from "../features/authentication/controller";
import {
  browserHandoffEnv,
  captureHandoff,
  rememberInvitation,
} from "../features/authentication/handoff";
import { signInRequest } from "../features/authentication/sign-in-request";
import {
  AuthStoreOpenError,
  browserPorts,
  type CreateSessionOptions,
  createProtectedSurface,
  createSession,
  type OpenedAuthStore,
  openAuthStore,
  rangeFromPin,
  runAuthCanary,
  type Session,
  SessionProvider,
  type Trace,
} from "../session";
import { CompatibilityScreen } from "./CompatibilityScreen";
import {
  browserEnv,
  type CapabilityReport,
  checkCapabilities,
  probeCapabilities,
} from "./capabilities";
import { type DataLeaderHandle, dataLeader } from "./data-leader";

/**
 * The boot sequence (plan 5.4), shared by the production entry (`main.tsx`) and the fixture-only session harness
 * (`src/fixture/session-harness`), so a real-engine test runs the production composition. Order: synchronous capability
 * check; the bounded probes including the `atlas-auth` canary (any issue shows the compatibility screen and NOTHING else, and
 * `start()` is not called); then the protected tree is loaded (D-10); `createSession` and `start()` run OUTSIDE any component
 * effect (React StrictMode double-invokes effects); one neutral React root renders `session.view`.
 *
 * Nothing here lifts the gate: only the session's `act` does, through the protected-surface adapter. The URL fragment (the OIDC
 * grant, an invitation token) is captured and stripped by the FIRST statement of `boot`, before any `await` (WEB-08b).
 */
export interface Booted {
  session: Session;
  store: OpenedAuthStore;
  /** The page's production sync leader (WEB-09b), or null when the composition does not start one (a fixture page that asks not to). */
  leader: DataLeaderHandle | null;
}
export interface BootOptions {
  neutralRoot: HTMLElement;
  /** Called synchronously before the session starts. The fragment capture is not here: it is the first statement of `boot`. */
  beforeStart?: () => void;
  onReload?: () => void;
  /** Test instrumentation only (the fixture-only harness). */
  trace?: Trace;
  /**
   * Session constants to override, for the FIXTURE harness only (the contention measurements scale `lockWaitMs`, and say so).
   * Production passes none: `main.tsx` never sets it.
   */
  config?: NonNullable<CreateSessionOptions["config"]>;
  /**
   * WEB-09b (P-13): start the production sync leader (the election, the engine, the dispatcher and the recovery job) at session level.
   * Defaults to TRUE and `main.tsx` never passes `false` (a static test asserts it). Only the fixture session harness turns it off, so its
   * own test leader and the evidence recorded with it keep their meaning (two engines must never issue `/sync` on one page).
   */
  dataLeader?: boolean;
}

export async function boot(options: BootOptions): Promise<Booted | null> {
  // THE FIRST STATEMENT, before any `await`: copy what the fragment carries (an OIDC grant, an invitation token) and strip it
  // from the address bar and the history entry (matrix 3.4 step 2). Nothing below may run before this.
  const handoff = captureHandoff(browserHandoffEnv());
  rememberInvitation(handoff.invitation);
  // A fragment-only navigation (pasting another link into the address bar of this open page) does not reload it: it is captured
  // and stripped the same way, so a grant or a token never stays in the address bar or the history.
  let live: Session | null = null;
  let finishLanding: typeof completeLanding | null = null;
  window.addEventListener("hashchange", () => {
    const next = captureHandoff(browserHandoffEnv());
    rememberInvitation(next.invitation);
    if (next.oidc && live && finishLanding) void finishLanding(live, next.oidc);
  });
  const reactRoot = createRoot(options.neutralRoot);
  const render = (node: ReactNode) =>
    reactRoot.render(
      <StrictMode>
        <ThemeProvider>{node}</ThemeProvider>
      </StrictMode>,
    );
  const showCompatibility = (report: CapabilityReport) =>
    render(<CompatibilityScreen issues={report.issues} />);

  const presence = checkCapabilities();
  if (!presence.ok) {
    showCompatibility(presence);
    return null;
  }
  render(<NeutralGate heading="Atlas" message="Opening Atlas…" />);

  let store: OpenedAuthStore | null = null;
  try {
    store = await openAuthStore();
  } catch (error) {
    if (!(error instanceof AuthStoreOpenError)) throw error;
  }
  const opened = store;
  const report = await probeCapabilities({
    ...browserEnv(),
    canary: () => (opened ? runAuthCanary(opened) : Promise.resolve(false)),
  });
  if (!report.ok || !opened) {
    showCompatibility(
      report.ok
        ? { ok: false, issues: [{ id: "indexeddb", reason: "failed" }] }
        : report,
    );
    return null;
  }

  // D-10: load the protected tree, neutral forms and landing controller after the capability checks, but before any session
  // starts or `expose` runs. Fragment capture remains synchronous above; `act` never waits for a component import.
  // Keeping the forms/controller off the initial boot path preserves the startup budget when authentication and sync are composed.
  const [
    { createProtectedTree },
    { SessionRoot },
    { completeLanding },
    lifecycle,
  ] = await Promise.all([
    import("./protected-tree"),
    import("./SessionRoot"),
    import("../features/authentication/controller"),
    // WEB-08c: the `1c.ended` producer and "Review this device" (loaded with the forms, before the session starts).
    import("./lifecycle-wiring"),
  ]);
  finishLanding = completeLanding;
  // The session and the surface refer to each other only through this closure: the surface asks for the tree, and the
  // tree needs the session for its screens.
  let renderTree: ((account: string) => ReactNode) | null = null;
  const surface = createProtectedSurface({
    renderTree: (account) => {
      if (!renderTree)
        throw new Error(
          "The protected tree was asked for before the session existed",
        );
      return renderTree(account);
    },
    gateDialog: createGateDialog(),
    liveRegions,
  });
  const session = createSession(
    browserPorts({
      store: opened,
      surface,
      trace: options.trace,
      // WEB-09a: the real database, local-work and wipe-coordination ports. Without this the session's defaults refuse
      // (`adapter_missing`) whenever an account database exists, so a wipe can never conclude "nothing to delete" about data
      // it cannot see.
      deletion: createDataDeletionPorts(),
    }),
    {
      supportedRange: rangeFromPin(contractVersion),
      onSignIn: () => signInRequest.request(),
      onReload: options.onReload ?? (() => location.reload()),
      onReviewDevice: () => lifecycle.reviewDevice(session),
      ...(options.config === undefined ? {} : { config: options.config }),
    },
  );
  live = session;
  renderTree = createProtectedTree(session);
  // Before `start`: an indeterminate attempt found at boot (begun before a reload or in another tab, T5/T8) is resolved during it.
  lifecycle.startAttemptEndWatcher(session);
  const leads = options.dataLeader !== false;
  // Before the session starts: the protected tree may be mounted during `start`, and its provider must then wait for the PAGE's runtime
  // that the leader composes rather than build one of its own (P-3).
  if (leads) dataLeader.announce();
  render(
    <SessionProvider session={session}>
      <SessionRoot />
    </SessionProvider>,
  );
  await session.start({ beforeStart: options.beforeStart });
  const leader = leads ? dataLeader.start(session, options.trace) : null;
  // The OIDC landing continues only now: the durable record decides (epoch and phase), never the order things happened in.
  if (handoff.oidc) void completeLanding(session, handoff.oidc);
  return { session, store: opened, leader };
}
