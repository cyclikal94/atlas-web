/**
 * Whether the person asked to sign in from a neutral state's button ("Sign in again", "Reconnect"), held in page memory
 * only. It replaces the provisional stub of WEB-08a: the request now leads to the real form (decision D-8b-02).
 * `username` is a prefill carried from the join page's lost-response state ("sign in with the details you chose"); the
 * password is never carried.
 */
export interface SignInRequest {
  readonly requested: boolean;
  readonly username: string;
}

const NONE: SignInRequest = { requested: false, username: "" };
type Listener = () => void;
const listeners = new Set<Listener>();
let current: SignInRequest = NONE;
const publish = () => {
  for (const listener of [...listeners]) listener();
};

export const signInRequest = {
  get: (): SignInRequest => current,
  request(username = ""): void {
    if (current.requested && current.username === username) return;
    current = { requested: true, username };
    publish();
  },
  clear(): void {
    if (current === NONE) return;
    current = NONE;
    publish();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
