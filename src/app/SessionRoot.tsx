import { useEffect, useRef, useSyncExternalStore } from "react";
import { NeutralGate } from "../components/ui/neutral-gate";
import { NeutralState } from "../components/ui/neutral-state";
import { authFeedback } from "../features/authentication/feedback";
import { invitationMemory } from "../features/authentication/handoff";
import { JoinSurface } from "../features/authentication/JoinSurface";
import { publicSurfaceFor } from "../features/authentication/public-route";
import { SignInSurface } from "../features/authentication/SignInSurface";
import { signInRequest } from "../features/authentication/sign-in-request";
import { switchFlow } from "../features/switch/state";
import {
  type NeutralStateId,
  useApiCompatibility,
  useSession,
  useSessionView,
} from "../session";
import { CompatibilityScreen, isApiRefusal } from "./CompatibilityScreen";

/**
 * The neutral states whose button ("Sign in again", "Reconnect") leads to the sign-in form. Every other state (all the gating
 * cards, 1e.*, 2, 3 and the consent prompt) NEVER shows a form: they are resolving something the person cannot answer with a
 * password (decision D-8b-02).
 */
export const SIGN_IN_STATES: ReadonlySet<NeutralStateId> = new Set([
  "1a.confirming",
  "1a.ended_elsewhere",
  "1b",
  "1d",
  "1c.ended",
]);

/**
 * The one neutral React root (`#neutral-root`), subscribed to `session.view`:
 *  - `booting`: the boot gate;
 *  - `incompatible`: the compatibility screen;
 *  - `signed_out` with no state: the compatibility screen when the server's `api_version` refuses it, otherwise the public
 *    surface for the path (`/join`, else the sign-in page);
 *  - a neutral state (signed out or not): its card, or, when its button asked to sign in and the state is one of
 *    `SIGN_IN_STATES`, the sign-in form with a Back control to that card;
 *  - `displaying`: nothing. The gate is lifted over the protected tree by `act`, and only by `act`.
 * It renders nothing about any account.
 */
export function SessionRoot({
  pathname = location.pathname,
}: {
  pathname?: string;
} = {}) {
  const view = useSessionView();
  const api = useApiCompatibility();
  const session = useSession();
  const request = useSyncExternalStore(
    signInRequest.subscribe,
    signInRequest.get,
    signInRequest.get,
  );
  // A NEW invitation link (a fragment-only navigation while this page is open) restarts the join page for it.
  const linkVersion = useSyncExternalStore(
    invitationMemory.subscribe,
    invitationMemory.version,
    invitationMemory.version,
  );
  const state =
    view.kind === "signed_out" || view.kind === "neutral" ? view.state : null;
  // WEB-08c (D-8c-04): "That sign-in didn't finish", raised by `attempt-end.ts` when an indeterminate sign-in was resolved and nothing
  // settled. On the signed-out sign-in surface it is the accepted 1c.ended CARD; its "Sign in again" leads to the form, and the fact is
  // then no longer news.
  const feedback = useSyncExternalStore(
    authFeedback.subscribe,
    authFeedback.get,
    authFeedback.get,
  );
  const ended = feedback.find((item) => item.kind === "ended") ?? null;
  // The request holds only while it can be answered: for a sign-in state, or for the join page's "Sign in".
  const answerable =
    (view.kind === "signed_out" && state === null) ||
    (state !== null && SIGN_IN_STATES.has(state));
  useEffect(() => {
    if (request.requested && !answerable) signInRequest.clear();
  }, [request.requested, answerable]);
  // Page-memory notices belong to the account that was displaying when they were raised. They go when a DIFFERENT account displays
  // or the person signs out. They do NOT go when the view merely flickers out of `displaying` for a moment (the resume verification
  // does that), which would swallow a notice the person has not seen yet. This component is always mounted, so React StrictMode's
  // double effect on mount cannot clear one early.
  const lastShown = useRef<string | null>(null);
  const shownAccount = view.kind === "displaying" ? view.account_id : null;
  const signedOut = view.kind === "signed_out" && view.state === null;
  useEffect(() => {
    if (shownAccount !== null) {
      if (lastShown.current !== null && lastShown.current !== shownAccount)
        authFeedback.clearOnBegin();
      lastShown.current = shownAccount;
      // WEB-08c: a switch journey opened by another account is no longer anyone's (the protected tree's host also drops it).
      switchFlow.dropUnless(shownAccount);
      // What the public surfaces carried across the neutral gate (a refusal for the sign-in form, a submitted invitation for the
      // join page) is only for them: once an account displays it is not news, and must not greet the next person to sign out.
      authFeedback.takeFailure();
      invitationMemory.forgetSpent();
    } else if (signedOut && lastShown.current !== null) {
      authFeedback.clearOnBegin();
      switchFlow.close();
      lastShown.current = null;
    }
  }, [shownAccount, signedOut]);

  switch (view.kind) {
    case "booting":
      return <NeutralGate heading="Atlas" message="Opening Atlas…" />;
    case "incompatible":
      return <CompatibilityScreen issues={view.issues} api={view.api} />;
    case "signed_out":
    case "neutral": {
      if (state === null) {
        if (isApiRefusal(api))
          return <CompatibilityScreen issues={[]} api={api} />;
        if (
          ended !== null &&
          !request.requested &&
          publicSurfaceFor(pathname) === "sign-in"
        )
          return (
            <NeutralState
              state="1c.ended"
              actions={{
                ...session.actions,
                signIn: () => {
                  authFeedback.dismiss(ended.id);
                  session.actions.signIn();
                },
              }}
            />
          );
        if (request.requested || publicSurfaceFor(pathname) === "sign-in")
          return <SignInSurface mode="signed_out" />;
        return <JoinSurface key={linkVersion} />;
      }
      if (SIGN_IN_STATES.has(state) && request.requested)
        return (
          <SignInSurface
            mode="reauthenticate"
            onBack={() => signInRequest.clear()}
          />
        );
      return (
        <NeutralState
          state={state}
          consent={view.kind === "neutral" ? view.consent : undefined}
          actions={session.actions}
        />
      );
    }
    case "displaying":
      return null;
  }
}
