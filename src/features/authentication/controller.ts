import type {
  AttemptOutcome,
  BeginResult,
  OidcStartOutcome,
  RegistrationInput,
  Session,
} from "../../session";
import { attemptEnd } from "./attempt-signal";
import { authFeedback } from "./feedback";
import type { OidcLanding } from "./handoff";
import { invitationMemory } from "./handoff";
import {
  type Message,
  messageForActivationRefusal,
  messageForError,
  messageForNotStarted,
} from "./outcome-copy";

/**
 * The application's side of the attempt methods: it begins an attempt, runs the one exchange the method needs, and maps what
 * came back to a CLOSED result a form can render (no free-form server text; see `outcome-copy.ts`). It publishes the facts that
 * must outlive the form that asked (`superseded`, a busy lock, a landing's outcome) to `authFeedback` itself, so they reach the
 * person even when that form has unmounted. It holds no password: a credential is a parameter of one call and is not kept.
 *
 * It decides nothing about identity: only the session module's settlement does that, and a `settled` result carries nothing
 * but the method.
 */
type SettledMethod = Extract<AttemptOutcome, { kind: "settled" }>["method"];

export type FormFailure = { kind: "failed"; message: Message };
export type NotDone =
  /** A gating attempt took over (the 1c card). Nothing for the form to show. */
  | { kind: "gating" }
  /** A newer attempt exists. The banner is published; the form has nothing to add. */
  | { kind: "superseded" }
  /** Another tab holds `atlas-auth`. The banner is published. */
  | { kind: "lock_timeout" };

export type SignInResult =
  | { kind: "settled"; method: SettledMethod }
  | NotDone
  | FormFailure;

export type RegisterResult =
  | { kind: "settled" }
  | NotDone
  /** A refusal that leaves the invitation usable (username taken, malformed value, throttled): the form stays. */
  | { kind: "failed"; message: Message }
  /** `401`: the invitation is unknown, expired, already used or revoked. The token is dropped. */
  | { kind: "unavailable" }
  /**
   * The outcome is unknown or the account was created but this browser could not finish: the token is dropped from memory
   * and the person is told to sign in with the details they chose. The client NEVER resubmits (decision D-8b-06).
   */
  | { kind: "lost_response" };

export type SsoResult = { kind: "navigating" } | NotDone | FormFailure;

export interface SsoEnv {
  /** Leaves the page for the provider. Called only after the attempt is durably `redirected`. */
  navigate(url: string): void;
}

const failed = (message: Message): FormFailure => ({ kind: "failed", message });

/** The `BeginResult`s that are not `started`, as results (the 1c banner for a busy lock is published here). */
function notStarted(
  begun: Exclude<BeginResult, { kind: "started" }>,
): SignInResult {
  switch (begun.kind) {
    case "resolving":
      return { kind: "gating" };
    case "lock_timeout":
      authFeedback.add({ kind: "lock_wait" });
      return { kind: "lock_timeout" };
    default:
      return failed({ id: "storage_unavailable" });
  }
}

function fromOutcome(
  outcome: AttemptOutcome,
  context: "sign_in" | "register",
): SignInResult {
  switch (outcome.kind) {
    case "settled":
      return { kind: "settled", method: outcome.method };
    case "refused":
      return failed(
        outcome.stage === "activation"
          ? messageForActivationRefusal(outcome.error)
          : messageForError(context, outcome.error),
      );
    case "exchange_failed":
      return failed({ id: "unreachable" });
    case "superseded":
      authFeedback.add({ kind: "superseded" });
      return { kind: "superseded" };
    case "gating":
      return { kind: "gating" };
    case "not_started":
      if (outcome.reason === "lock_timeout") {
        authFeedback.add({ kind: "lock_wait" });
        return { kind: "lock_timeout" };
      }
      return failed({ id: messageForNotStarted(outcome.reason) });
  }
}

/**
 * A password sign-in. A refusal is RETURNED and ALSO carried in page memory (`authFeedback.carryFailure`): between the exchange and
 * the activation the session view is the neutral gate, which unmounts the form that asked, so an activation refusal (device
 * capacity, a hidden tab, a pending wipe) arrives after the form has gone and belongs to the form that mounts next (review R1).
 * The form shows the carried message and takes it; the return value is for callers that are still there.
 */
export async function signIn(
  session: Session,
  credentials: { username: string; password: string },
): Promise<SignInResult> {
  authFeedback.clearOnBegin();
  const before = session.identity.get();
  const begun = await session.attempts.begin("password");
  if (begun.kind !== "started") {
    const result = notStarted(begun);
    if (result.kind === "failed") authFeedback.carryFailure(result.message);
    return result;
  }
  const outcome = await session.attempts.signInWithPassword(
    begun.handle,
    credentials,
  );
  // WEB-08c (D-8c-04): an indeterminate activation; "That sign-in didn't finish" follows if it resolves with nothing settled.
  if (outcome.kind === "gating") attemptEnd.indeterminate(before);
  const result = fromOutcome(outcome, "sign_in");
  if (result.kind === "failed") authFeedback.carryFailure(result.message);
  return result;
}

/** Codes of an exchange refusal that leave the invitation usable. A `401` is the one that does not. */
const KEEPS_TOKEN = new Set([
  "conflict",
  "invalid_value",
  "malformed_request",
  "rate_limited",
  "forbidden",
  "not_found",
  "temporarily_unavailable",
]);

/**
 * Registration by invitation. The invitation is TAKEN out of page memory for the exchange, and from the moment the redemption
 * request has been sent there are only three outcomes for it (T16, WF Q21 "Lost-response recovery"):
 *
 *  - it was refused in a way that leaves the invitation usable (a taken username, a malformed value, a throttle): the token is put
 *    back and the form stays;
 *  - it was refused as unusable (`401`): the token is dropped and the person is told so;
 *  - anything else: the account exists, or may exist, and the invitation is consumed or may be. The token is gone for good, the
 *    page remembers it as SPENT with the username the person chose, and the person is directed to sign in with those details.
 *    Nothing resubmits (decision D-8b-06), and no surface offers the form again.
 *
 * Every one of those changes to page memory goes through THIS submission's `Redemption` and applies only while the page still holds
 * the invitation that was submitted. A different link can arrive while the request is outstanding (a fragment-only navigation):
 * the late result then neither puts the earlier token back nor retires the newer link's form. A spent submission the page has
 * moved on from is remembered as `earlier` and told beside the newer link, not in its place (review R5).
 *
 * "Anything else" includes every `not_started` that `registerWithInvitation` returns: the session module sends the redemption
 * FIRST, so a `hidden`, `lock_timeout`, `wipe_pending` or `attempt_gone` is a failure to ACTIVATE a grant the redemption already
 * returned, not a failure to begin (a failure to begin is `attempts.begin`, handled before the request exists). The module's
 * tests pin that ordering. Review R2.
 */
export async function register(
  session: Session,
  input: RegistrationInput,
): Promise<RegisterResult> {
  authFeedback.clearOnBegin();
  // The token leaves page memory for the exchange: whatever happens next, nothing else can use it, and a window that
  // mounts the protected tree meanwhile does not mistake this tab for one that still holds an unused invitation. The link
  // generation is captured here, before anything is sent, so a late result is bound to the invitation that was submitted.
  const redemption = invitationMemory.take(input.token);
  const restore = () => redemption.restore();
  const spend = () => redemption.spend(input.username);
  const begun = await session.attempts.begin("registration");
  if (begun.kind !== "started") {
    // Nothing was sent: the invitation is untouched.
    restore();
    const result = notStarted(begun);
    return result.kind === "settled" ? { kind: "gating" } : result;
  }
  const lost = (): RegisterResult => {
    spend();
    return { kind: "lost_response" };
  };
  const outcome = await session.attempts.registerWithInvitation(
    begun.handle,
    input,
  );
  switch (outcome.kind) {
    case "settled":
      return { kind: "settled" };
    case "refused": {
      if (outcome.stage === "activation") return lost();
      if (outcome.error.code === "unauthenticated")
        return { kind: "unavailable" };
      if (KEEPS_TOKEN.has(outcome.error.code)) {
        restore();
        return failed(messageForError("register", outcome.error));
      }
      // Any other code: the invitation's state is not known to be intact.
      return lost();
    }
    case "exchange_failed":
      return lost();
    case "superseded":
      // The result is discarded (a newer attempt exists, T1) but the request was SENT: the account and the invitation were
      // committed on the server whatever happened to this response (T16). The live form must not stay usable, and the person
      // signs in with the credentials they chose. The banner says why this page is not showing the new account.
      spend();
      authFeedback.add({ kind: "superseded" });
      return { kind: "superseded" };
    case "gating":
      // The activation's outcome is unknown; the gate owns the screen until it resolves, and what remains is the spent state.
      spend();
      return { kind: "gating" };
    case "not_started":
      return lost();
  }
}

function fromSsoStart(outcome: OidcStartOutcome, env: SsoEnv): SsoResult {
  switch (outcome.kind) {
    case "redirect":
      env.navigate(outcome.authorization_url);
      return { kind: "navigating" };
    case "refused":
      return failed(messageForError("sso", outcome.error));
    case "exchange_failed":
      return failed({ id: "unreachable" });
    case "superseded":
      authFeedback.add({ kind: "superseded" });
      return { kind: "superseded" };
    case "session_ended":
      // The session the link needs has ended: the neutral state ("Reconnect to keep going") takes over the screen.
      return { kind: "gating" };
    case "not_started":
      return failed({ id: "interrupted" });
  }
}

/** Single sign-on, or linking it from Settings. Never navigates before the attempt is durably `redirected`. */
export async function startSso(
  session: Session,
  options: { link: boolean },
  env: SsoEnv,
): Promise<SsoResult> {
  authFeedback.clearOnBegin();
  const begun = await session.attempts.begin(
    options.link ? "oidc_link" : "oidc",
  );
  if (begun.kind !== "started") {
    const result = notStarted(begun);
    return result.kind === "settled" ? { kind: "gating" } : result;
  }
  return fromSsoStart(await session.attempts.startOidc(begun.handle), env);
}

/**
 * The OIDC landing, after the fragment was captured and stripped at boot and the session has started. It tells the person
 * what happened through `authFeedback`: a stale or invalid landing, a failure, or (for a link) that linking worked.
 */
export async function completeLanding(
  session: Session,
  landing: OidcLanding,
): Promise<void> {
  if (landing.kind === "invalid") {
    authFeedback.add({
      kind: "message",
      tone: "problem",
      message: { id: "sso_landing_invalid" },
    });
    return;
  }
  const before = session.identity.get();
  const outcome = await session.attempts.landing(landing.fragment);
  switch (outcome.kind) {
    case "settled":
      if (outcome.method === "oidc_link")
        authFeedback.add({
          kind: "message",
          tone: "info",
          message: { id: "sso_linked" },
        });
      return;
    case "superseded":
      authFeedback.add({ kind: "superseded" });
      return;
    case "refused":
      authFeedback.add({
        kind: "message",
        tone: "problem",
        message:
          outcome.stage === "activation"
            ? messageForActivationRefusal(outcome.error)
            : messageForError("sso", outcome.error),
      });
      return;
    case "exchange_failed":
    case "not_started":
      authFeedback.add({
        kind: "message",
        tone: "problem",
        message: { id: "sso_landing_failed" },
      });
      return;
    case "gating":
      // The 1c card owns the screen until the attempt resolves; if it resolves with nothing settled, "That sign-in didn't finish".
      attemptEnd.indeterminate(before);
      return;
  }
}
