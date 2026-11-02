import { useSyncExternalStore } from "react";
import { type Session, useSession } from "../../session";
import { signIn, startSso } from "./controller";
import { authFeedback } from "./feedback";
import { FeedbackBanners, PublicCard } from "./PublicCard";
// WEB-14a revision 40 (R40-GATE; C2): the page memory's update holds follow it from now on (`held-memory.ts`).
import "./held-memory";
import { SignInForm } from "./SignInForm";
import { signInRequest } from "./sign-in-request";
import { useNeutralTitle } from "./use-neutral-title";
import { useOnline } from "./use-online";

/** Leaves the page for the provider. Called only after the attempt is durably `redirected`. */
const browserNavigate = (url: string) => location.assign(url);

/**
 * The production sign-in surface (it replaces `NeutralEntry` and the provisional stub). Two modes:
 *  - `signed_out`: nobody is signed in and no neutral state applies: the standalone page.
 *  - `reauthenticate`: a neutral state's button ("Sign in again", "Reconnect") led here, with a Back control to that card.
 * The heading differs; the form is the same. It shows nothing about any account: before settlement no name, id or cookie
 * state exists to show, and the account the form signs in is the person's to type.
 */
export function SignInSurface({
  mode,
  onBack,
  session: provided,
  navigate = browserNavigate,
}: {
  mode: "signed_out" | "reauthenticate";
  onBack?(): void;
  /** Tests only: the session the form uses when no provider wraps it. */
  session?: Session;
  navigate?(url: string): void;
}) {
  const fromContext = useSession();
  const session = provided ?? fromContext;
  const online = useOnline();
  useNeutralTitle("Sign in");
  const feedback = useSyncExternalStore(
    authFeedback.subscribe,
    authFeedback.get,
    authFeedback.get,
  );
  const request = useSyncExternalStore(
    signInRequest.subscribe,
    signInRequest.get,
    signInRequest.get,
  );
  // A refusal that arrived while the neutral gate had this surface unmounted (an activation refusal), or that the controller
  // has just produced. The form shows it and takes it (review R1).
  const carried = useSyncExternalStore(
    authFeedback.subscribe,
    authFeedback.carriedFailure,
    authFeedback.carriedFailure,
  );
  // WEB-14a revision 39 (design assessment DA-AUTH-HOSTS, C1): a username carried here from another step (the one chosen when joining)
  // lives in page memory only: an app update does not reload over it. Revision 40 (R40-GATE; C2): held as the request changes (`held-memory.ts`).
  return (
    <PublicCard
      surface="sign-in"
      focusKey={mode}
      heading={mode === "reauthenticate" ? "Sign in again" : "Sign in to Atlas"}
      banners={<FeedbackBanners items={feedback} />}
    >
      <SignInForm
        // WEB-14a revision 40 (R40-GATE): one form per host: a neutral state's form never hands its typed state to the public page's.
        key={mode}
        online={online}
        initialUsername={request.username}
        onSubmit={(credentials) => signIn(session, credentials)}
        onSso={() => startSso(session, { link: false }, { navigate })}
        onBack={mode === "reauthenticate" ? onBack : undefined}
        // Revision 39 (DA-AUTH-HOSTS): a neutral state's sign-in is not the public page's.
        recoveryContext={
          mode === "reauthenticate" ? "sign-in:again" : "sign-in"
        }
        carried={carried}
        onCarriedShown={() => authFeedback.takeFailure()}
      />
    </PublicCard>
  );
}
