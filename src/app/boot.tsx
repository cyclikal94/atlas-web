import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
// A named import, so the bundler keeps the version and drops the rest (the release URL must not ship in the client).
import { version as contractVersion } from "../../contract-pin.json";
import { liveRegions } from "../components/ui/announcer";
import { createGateDialog } from "../components/ui/gate-dialog";
import { NeutralGate } from "../components/ui/neutral-gate";
import { createDataDeletionPorts } from "../data";
import { ThemeProvider } from "../design/ThemeProvider";
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
import { SessionRoot } from "./SessionRoot";
import { signInStub } from "./sign-in-stub";

/**
 * The boot sequence (plan 5.4), shared by the production entry (`main.tsx`) and the fixture-only session harness
 * (`src/fixture/session-harness`), so a real-engine test runs the production composition. Order: synchronous capability
 * check; the bounded probes including the `atlas-auth` canary (any issue shows the compatibility screen and NOTHING else, and
 * `start()` is not called); then the protected tree is loaded (D-10); `createSession` and `start()` run OUTSIDE any component
 * effect (React StrictMode double-invokes effects); one neutral React root renders `session.view`.
 *
 * Nothing here lifts the gate: only the session's `act` does, through the protected-surface adapter. This module does not touch
 * `location.hash`, because WEB-08b reads the OIDC grant from the URL fragment (`beforeStart` is where that capture goes).
 */
export interface Booted {
  session: Session;
  store: OpenedAuthStore;
}
export interface BootOptions {
  neutralRoot: HTMLElement;
  /** Called synchronously before the session starts; WEB-08b's fragment capture goes here. */
  beforeStart?: () => void;
  onReload?: () => void;
  /** Test instrumentation only (the fixture-only harness). */
  trace?: Trace;
  /**
   * Session constants to override, for the FIXTURE harness only (the contention measurements scale `lockWaitMs`, and say so).
   * Production passes none: `main.tsx` never sets it.
   */
  config?: NonNullable<CreateSessionOptions["config"]>;
}

export async function boot(options: BootOptions): Promise<Booted | null> {
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

  // D-10: the protected tree is loaded before `expose` starts, so `act` mounts it in one synchronous step.
  const { createProtectedTree } = await import("./protected-tree");
  // The session and the surface refer to each other only through this closure: the surface asks for the tree, and the
  // tree needs the session for its screens.
  let renderTree: (() => ReactNode) | null = null;
  const surface = createProtectedSurface({
    renderTree: () => {
      if (!renderTree)
        throw new Error(
          "The protected tree was asked for before the session existed",
        );
      return renderTree();
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
      onSignIn: () => signInStub.request(),
      onReload: options.onReload ?? (() => location.reload()),
      ...(options.config === undefined ? {} : { config: options.config }),
    },
  );
  renderTree = createProtectedTree(session);
  render(
    <SessionProvider session={session}>
      <SessionRoot />
    </SessionProvider>,
  );
  await session.start({ beforeStart: options.beforeStart });
  return { session, store: opened };
}
