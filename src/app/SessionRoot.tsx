import { lazy, Suspense, useSyncExternalStore } from "react";
import { NeutralLiveRegion } from "../components/ui/announcer";
import { NeutralGate } from "../components/ui/neutral-gate";
import { NeutralState } from "../components/ui/neutral-state";
import { useAppUpdate } from "../lib/pwa/store";
import { useApiCompatibility, useSession, useSessionView } from "../session";
import { CompatibilityScreen, isApiRefusal } from "./CompatibilityScreen";
import { NeutralEntry } from "./NeutralEntry";
import { SIGN_IN_UNAVAILABLE, signInStub } from "./sign-in-stub";

/**
 * The one neutral React root (`#neutral-root`), subscribed to `session.view`:
 *  - `booting`: the boot gate;
 *  - `incompatible`: the compatibility screen;
 *  - `signed_out`: the neutral entry (or the compatibility screen when the server's `api_version` refuses it, or the
 *    consent prompt when a confirmed wipe is waiting for the person's choice);
 *  - `neutral`: the neutral state named by the record, with the actions the composition root supplies;
 *  - `displaying`: nothing. The gate is lifted over the protected tree by `act`, and only by `act`.
 * It renders nothing about any account.
 */
// The neutral update banner (WEB-14a) is loaded only when there is something to say: the initial chunk carries the import, not the banner.
const NeutralUpdateBanner = lazy(() => import("../lib/pwa/UpdateBanner"));

export function SessionRoot() {
  const update = useAppUpdate();
  const view = useSessionView();
  const screen = <NeutralScreen />;
  // While the account is displayed the shell shows the banner itself (`AppUpdateBanner`), and announces it through the protected tree.
  if (view.kind === "displaying") return screen;
  // The neutral live region is mounted (empty) whenever no account is displayed, BEFORE an update can be offered: a region inserted with
  // its message is not reliably announced (revision 1, R8).
  return (
    <>
      {screen}
      <NeutralLiveRegion />
      {update.kind === "none" ? null : (
        <Suspense fallback={null}>
          <NeutralUpdateBanner />
        </Suspense>
      )}
    </>
  );
}

function NeutralScreen() {
  const view = useSessionView();
  const api = useApiCompatibility();
  const session = useSession();
  const signInRequested = useSyncExternalStore(
    signInStub.subscribe,
    signInStub.get,
    signInStub.get,
  );
  const unavailable = signInRequested ? SIGN_IN_UNAVAILABLE : null;
  switch (view.kind) {
    case "booting":
      return <NeutralGate heading="Atlas" message="Opening Atlas…" />;
    case "incompatible":
      return <CompatibilityScreen issues={view.issues} api={view.api} />;
    case "signed_out":
      if (view.state)
        return (
          <NeutralState
            state={view.state}
            actions={session.actions}
            unavailable={unavailable}
          />
        );
      if (isApiRefusal(api))
        return <CompatibilityScreen issues={[]} api={api} />;
      return <NeutralEntry />;
    case "neutral":
      return (
        <NeutralState
          state={view.state}
          consent={view.consent}
          actions={session.actions}
          unavailable={unavailable}
        />
      );
    case "displaying":
      return null;
  }
}
