import { useSyncExternalStore } from "react";
import { NeutralGate } from "../components/ui/neutral-gate";
import { NeutralState } from "../components/ui/neutral-state";
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
export function SessionRoot() {
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
