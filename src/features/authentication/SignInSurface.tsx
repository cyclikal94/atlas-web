import { useSyncExternalStore } from "react";
import { type Session, useSession } from "../../session";
import { signIn, startSso } from "./controller";
import { authFeedback } from "./feedback";
import { FeedbackBanners, PublicCard } from "./PublicCard";
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
  return (
    <PublicCard
      surface="sign-in"
      focusKey={mode}
      heading={mode === "reauthenticate" ? "Sign in again" : "Sign in to Atlas"}
      banners={<FeedbackBanners items={feedback} />}
    >
      <SignInForm
        online={online}
        initialUsername={request.username}
        onSubmit={(credentials) => signIn(session, credentials)}
        onSso={() => startSso(session, { link: false }, { navigate })}
        onBack={mode === "reauthenticate" ? onBack : undefined}
        carried={carried}
        onCarriedShown={() => authFeedback.takeFailure()}
      />
    </PublicCard>
  );
}
