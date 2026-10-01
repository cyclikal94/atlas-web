/**
 * PROVISIONAL, replaced by WEB-08b. Until a sign-in surface exists, every "Sign in again" or "Reconnect" button in a neutral
 * state leads here: the button is honest about what is available. The line is the one `NeutralEntry` already shows.
 */
export const SIGN_IN_UNAVAILABLE = "Sign-in isn't available in this build yet.";

type Listener = () => void;
const listeners = new Set<Listener>();
let requested = false;

export const signInStub = {
  get: (): boolean => requested,
  request(): void {
    if (requested) return;
    requested = true;
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
