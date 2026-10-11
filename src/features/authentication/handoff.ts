import { isJoinPath } from "./public-route";

/**
 * Boot-time capture of what the URL fragment carries (matrix 3.4 step 2, 3.4.1): the OIDC grant that the backend's callback
 * puts in `#atlas_grant=…&atlas_attempt=…&atlas_account=…`, and the invitation token in `/join#t=…`.
 *
 * `captureHandoff` is the FIRST statement of `boot()` and is synchronous: it copies the values out and strips the
 * fragment with `history.replaceState` before any `await`, before the capability probes and before any request, so a grant
 * or a token never sits in the address bar, the history entry or a screenshot while the page works. The strip happens
 * whenever a recognised key is present, valid or not. A fragment this client does not recognise is left alone.
 *
 * The fragment is form-urlencoded (the backend builds it with `url::form_urlencoded`), so it is parsed with
 * `URLSearchParams`, never split on `&`. Nothing here writes a value to storage, a log or the trace.
 */
export interface HandoffEnv {
  readonly pathname: string;
  readonly search: string;
  /** `location.hash`, including the leading `#` when there is one. */
  readonly hash: string;
  replaceState(url: string): void;
}

export type OidcLanding =
  | {
      kind: "valid";
      fragment: { grant: string; attempt: string; account: string };
    }
  | { kind: "invalid" };

export type InvitationHandoff =
  | { kind: "token"; token: string }
  | { kind: "invalid" };

export interface Handoff {
  oidc: OidcLanding | null;
  invitation: InvitationHandoff | null;
}

const GRANT = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const ATTEMPT = /^[0-9]{1,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OIDC_KEYS = ["atlas_grant", "atlas_attempt", "atlas_account"] as const;

export function captureHandoff(env: HandoffEnv): Handoff {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(
      env.hash.startsWith("#") ? env.hash.slice(1) : env.hash,
    );
  } catch {
    return { oidc: null, invitation: null };
  }
  const hasOidc = OIDC_KEYS.some((key) => params.has(key));
  const onJoin = isJoinPath(env.pathname);
  const hasToken = onJoin && params.has("t");
  if (!hasOidc && !hasToken) return { oidc: null, invitation: null };

  let oidc: OidcLanding | null = null;
  if (hasOidc) {
    const grant = params.get("atlas_grant");
    const attempt = params.get("atlas_attempt");
    const account = params.get("atlas_account");
    oidc =
      grant !== null &&
      attempt !== null &&
      account !== null &&
      GRANT.test(grant) &&
      ATTEMPT.test(attempt) &&
      UUID.test(account)
        ? { kind: "valid", fragment: { grant, attempt, account } }
        : { kind: "invalid" };
  }
  let invitation: InvitationHandoff | null = null;
  if (hasToken) {
    const token = params.get("t");
    invitation =
      token !== null && TOKEN.test(token)
        ? { kind: "token", token }
        : { kind: "invalid" };
  }
  // The query survives (nothing in this client puts a secret in a query); only the fragment goes.
  env.replaceState(env.pathname + env.search);
  return { oidc, invitation };
}

export const browserHandoffEnv = (): HandoffEnv => ({
  pathname: location.pathname,
  search: location.search,
  hash: location.hash,
  replaceState: (url) => history.replaceState(null, "", url),
});

/**
 * The invitation token of this page, held in a module variable and nowhere else: not storage, not a cookie, not the URL, not
 * the trace. `unset` is a page opened at `/join` without a fragment (a reload after the strip), which is "no longer valid".
 *
 * `spent` is what this page KNOWS about an invitation it has submitted whose redemption committed or is in doubt: the account may
 * exist and the token is consumed or may be. It outlives the form that submitted (the neutral gate unmounts the join surface
 * between the redemption and the activation, and a surface that mounts afterwards must not read "no longer valid, ask for a new
 * invitation") and it retires a live form's submission capability. It carries the username the person chose, never a secret, and
 * it is forgotten as soon as an account displays (review R1/R2).
 *
 * `earlier` is the same fact about an invitation the page has MOVED ON from: a different link was opened (a fragment-only
 * navigation) while the submission was outstanding or after it was spent. The newer link keeps the page; the earlier submission is
 * told beside it, never in its place, and never attributed to it (review R5).
 */
type Memory =
  | { kind: "unset" }
  | { kind: "token"; token: string }
  | { kind: "invalid" }
  | { kind: "spent"; username: string };
let memory: Memory = { kind: "unset" };
/** The username chosen for an earlier invitation whose redemption committed or is in doubt, once a newer link holds the page. */
let earlier: string | null = null;
/** Changes only when a NEW link arrives, so the join page restarts for it; a redemption's `restore` and `spend` do not change it. */
let version = 0;
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of [...listeners]) listener();
};

/** A link is replacing the page's invitation: what the page knew about a submitted one is kept as `earlier`, not lost. */
function displace(): void {
  if (memory.kind === "spent") earlier = memory.username;
  version += 1;
}

/**
 * ONE submission's hold on the invitation, returned by `take`. Everything the exchange later does to page memory goes through it
 * and applies only while the page still holds the invitation that was submitted: the same link generation, or the same token
 * pasted again. A result that arrives after a DIFFERENT link replaced it (a late response, a lost response, a refusal that would
 * put the token back) must not retire or overwrite that link (review R5).
 */
export interface Redemption {
  /** The exchange left the invitation usable (or never began): put the token back, unless the page has moved on. */
  restore(): void;
  /**
   * The redemption was sent and its outcome is no longer the form's to retry: the token is gone (it must never be offered again)
   * and the person is directed to sign in with the details they chose. If the page has moved on to another link, that link is
   * left exactly as it is and the submission is remembered as `earlier`.
   */
  spend(username: string): void;
}

export const invitationMemory = {
  get: (): Memory => memory,
  /** The token, or null. Does not remove it. */
  peek: (): string | null => (memory.kind === "token" ? memory.token : null),
  /** The earlier submission, if a newer link holds the page. */
  earlier: (): string | null => earlier,
  /** A link arrived (boot, or a fragment-only navigation). */
  set(token: string): void {
    displace();
    memory = { kind: "token", token };
    publish();
  },
  markInvalid(): void {
    displace();
    memory = { kind: "invalid" };
    publish();
  },
  /**
   * The token leaves page memory for ONE exchange: whatever happens next, nothing else can use it, and a window that mounts the
   * protected tree meanwhile does not mistake this tab for one that still holds an unused invitation. The link generation is
   * captured here, before anything is sent.
   */
  take(token: string): Redemption {
    const generation = version;
    const holds = () =>
      version === generation ||
      (memory.kind === "token" && memory.token === token);
    if (memory.kind !== "unset") {
      memory = { kind: "unset" };
      publish();
    }
    return {
      restore() {
        if (!holds()) return;
        memory = { kind: "token", token };
        publish();
      },
      spend(username) {
        if (holds()) memory = { kind: "spent", username };
        else earlier = username;
        publish();
      },
    };
  },
  /** An account is displaying, so what this page knew about a submitted invitation is no longer news. */
  forgetSpent(): void {
    if (memory.kind !== "spent" && earlier === null) return;
    if (memory.kind === "spent") memory = { kind: "unset" };
    earlier = null;
    publish();
  },
  /** The person has read the note about an earlier submission. */
  dismissEarlier(): void {
    if (earlier === null) return;
    earlier = null;
    publish();
  },
  version: (): number => version,
  /** Forget everything this page holds about invitations: the link, a spent submission and an earlier one. */
  clear(): void {
    if (memory.kind === "unset" && earlier === null) return;
    memory = { kind: "unset" };
    earlier = null;
    publish();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function rememberInvitation(handoff: InvitationHandoff | null): void {
  if (!handoff) return;
  if (handoff.kind === "token") invitationMemory.set(handoff.token);
  else invitationMemory.markInvalid();
}
