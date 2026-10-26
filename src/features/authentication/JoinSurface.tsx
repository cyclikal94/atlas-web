import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../../components/ui/button";
import { NeutralStatus } from "../../components/ui/neutral-status";
import {
  type InvitationPreview,
  type Session,
  useSession,
} from "../../session";
import { register } from "./controller";
import { authFeedback } from "./feedback";
import { formatExpiry } from "./format";
import { invitationMemory } from "./handoff";
import { JoinForm } from "./JoinForm";
import { MessageText } from "./MessageText";
import { MESSAGE_TEXT, type Message, messageForError } from "./outcome-copy";
import { FeedbackBanners, PublicCard } from "./PublicCard";
import { signInRequest } from "./sign-in-request";
import { useNeutralTitle } from "./use-neutral-title";
import { useOnline } from "./use-online";

/** [W] registration.html State 0 / "no fragment": a reload after the token was stripped, or a bookmarked link. */
export const LINK_INVALID =
  "This link is no longer valid — ask for a new invitation";
/** [W] registration.html, "Lost-response recovery (Er)". */
export const LOST_RESPONSE =
  "If you already submitted this and lost the confirmation, don't try again — sign in with the details you chose.";
/**
 * [P] (design gap G-14 family): what is said beside a NEWER invitation about an earlier one the person submitted. The wording is
 * fixed: it names no username and no invitation (a live region carries closed catalogue strings only), and it never speaks
 * for the invitation now on screen.
 */
export const EARLIER_HEADING = "Check whether your earlier account was created";
export const EARLIER_MESSAGE =
  "You opened another invitation, so the result of the earlier one isn't shown here. If you already submitted it, don't try again — sign in with the details you chose.";

type Phase =
  | { kind: "loading" }
  | {
      kind: "ready";
      household: { id: string; name: string } | null;
      expiresAt: string;
    }
  | { kind: "unavailable"; afterSubmit: boolean }
  | { kind: "error"; message: Message };

const previewError = (
  preview: Exclude<InvitationPreview, { kind: "ok" } | { kind: "unavailable" }>,
): Message =>
  preview.kind === "network_failure"
    ? { id: "unreachable" }
    : messageForError("register", {
        code: preview.error.code,
        request_id: preview.error.request_id,
      });

/**
 * `/join` for a signed-out browser (WF Q21 gap 1). The token was captured from the fragment at boot, stripped from the
 * address bar and held in memory only; the preview is requested with it in the request BODY. The surface holds the token in
 * its own state from first render, so taking it out of memory for the submit does not make the form vanish.
 *
 * Once the invitation has been SUBMITTED and its redemption committed or is in doubt, page memory says `spent` (the controller
 * decides, from what the session module returned) and this surface shows the sign-in recovery in place of everything else. It reads
 * that from the shared memory, not from its own state, for two reasons (review R1/R2): the neutral gate unmounts this surface
 * between the redemption and the activation, so the surface that mounts afterwards has to find the recovery waiting for it and
 * not "this link is no longer valid"; and a result that is discarded as stale (a newer attempt exists) still leaves this form on
 * screen, which must not offer the consumed invitation again.
 *
 * A DIFFERENT link can replace this one while a submission is outstanding. The surface restarts for the newer link (`SessionRoot`
 * keys it by the link generation) and the earlier submission's late result is bound to the invitation it was submitted from, so
 * it cannot retire the newer form. What it learned is told beside the newer link (`EarlierRegistration`), with its own way to
 * sign in, and is attributed to nothing on screen (review R5).
 */
export function JoinSurface({ session: provided }: { session?: Session }) {
  const fromContext = useSession();
  const session = provided ?? fromContext;
  const online = useOnline();
  useNeutralTitle("Join");
  const feedback = useSyncExternalStore(
    authFeedback.subscribe,
    authFeedback.get,
    authFeedback.get,
  );
  const [token] = useState(() => invitationMemory.peek());
  const memory = useSyncExternalStore(
    invitationMemory.subscribe,
    invitationMemory.get,
    invitationMemory.get,
  );
  const earlier = useSyncExternalStore(
    invitationMemory.subscribe,
    invitationMemory.earlier,
    invitationMemory.earlier,
  );
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const username = useRef("");

  // The preview: not an attempt, so it is safe while anyone is signed in; an in-flight request is aborted when the page hides.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the "Try again" trigger and is deliberately a dependency
  useEffect(() => {
    if (token === null) return;
    setPhase({ kind: "loading" });
    const controller = new AbortController();
    // A page that is hidden does not keep a request open (a hidden page may freeze); when it is visible again the preview is asked
    // for again, so the person never comes back to a skeleton that nothing will ever fill.
    let hiddenWhileLoading = false;
    let settled = false;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (!settled) {
          hiddenWhileLoading = true;
          controller.abort();
        }
      } else if (hiddenWhileLoading) {
        hiddenWhileLoading = false;
        setAttempt((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    void session.attempts
      .previewInvitation(token, controller.signal)
      .then((preview) => {
        if (controller.signal.aborted) return;
        settled = true;
        if (preview.kind === "ok")
          setPhase({
            kind: "ready",
            household: preview.household,
            expiresAt: preview.expires_at,
          });
        else if (preview.kind === "unavailable")
          setPhase({ kind: "unavailable", afterSubmit: false });
        else setPhase({ kind: "error", message: previewError(preview) });
      });
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
    };
  }, [session, token, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const onSubmit = useCallback(
    async (input: { username: string; password: string }) => {
      if (token === null) return { kind: "unavailable" as const };
      username.current = input.username;
      const result = await register(session, { token, ...input });
      // `lost_response`, `superseded` and `gating` leave the invitation `spent` in page memory (see the controller), which is
      // what this surface draws from; only a plain `401` is local.
      if (result.kind === "unavailable")
        setPhase({ kind: "unavailable", afterSubmit: true });
      return result;
    },
    [session, token],
  );

  const banners = (
    <>
      {earlier !== null ? <EarlierRegistration username={earlier} /> : null}
      <FeedbackBanners items={feedback} />
    </>
  );

  if (memory.kind === "spent")
    return (
      <PublicCard
        surface="join"
        focusKey="lost"
        banners={banners}
        heading="Check whether your account was created"
      >
        <NeutralStatus kind="status">{LOST_RESPONSE}</NeutralStatus>
        <SignInLink username={memory.username} />
      </PublicCard>
    );

  if (token === null)
    return (
      <PublicCard
        surface="join"
        focusKey="invalid"
        heading={LINK_INVALID}
        banners={banners}
      >
        <SignInLink />
      </PublicCard>
    );

  switch (phase.kind) {
    case "loading":
      return (
        <PublicCard
          surface="join"
          focusKey="loading"
          focus={false}
          banners={banners}
          heading={
            <span aria-busy="true" data-skeleton="">
              <span className="sr-only">Loading your invitation…</span>
              <span
                aria-hidden="true"
                className="block h-7 w-3/4 animate-pulse rounded-md bg-muted"
              />
            </span>
          }
        >
          <div aria-hidden="true" className="flex flex-col gap-4">
            <span className="block h-4 w-full animate-pulse rounded-md bg-muted" />
            <span className="block h-11 w-full rounded-md border border-input bg-background opacity-60" />
            <span className="block h-11 w-full rounded-md border border-input bg-background opacity-60" />
          </div>
        </PublicCard>
      );
    case "ready": {
      const name = phase.household?.name ?? null;
      return (
        <PublicCard
          surface="join"
          focusKey="ready"
          banners={banners}
          heading={`You're invited to join ${name ?? "Atlas"}`}
        >
          {name ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              This invitation joins the {name} household. It expires{" "}
              {formatExpiry(phase.expiresAt)}.
            </p>
          ) : null}
          <JoinForm
            online={online}
            submitLabel={
              name ? `Create account and join ${name}` : "Create account"
            }
            onSubmit={onSubmit}
          />
        </PublicCard>
      );
    }
    case "unavailable":
      return (
        <PublicCard
          surface="join"
          focusKey="unavailable"
          banners={banners}
          heading="This invitation can't be used"
        >
          <NeutralStatus kind="status">
            {MESSAGE_TEXT.invitation_unavailable}
          </NeutralStatus>
          {phase.afterSubmit ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {LOST_RESPONSE}
            </p>
          ) : null}
          <SignInLink username={username.current} />
        </PublicCard>
      );
    case "error":
      return (
        <PublicCard
          surface="join"
          focusKey="error"
          banners={banners}
          heading="We couldn't open this invitation"
        >
          <NeutralStatus kind="alert">
            <MessageText message={phase.message} />
          </NeutralStatus>
          <div>
            <Button onClick={retry}>Try again</Button>
          </div>
        </PublicCard>
      );
  }
}

/**
 * What an EARLIER submission left behind, beside the invitation now on screen: the account may exist, the person should check
 * rather than submit again, and "Sign in" carries the username they chose for it (never a password). It sits in the banner slot,
 * so the form below keeps what the person has typed. It stays until an account displays or the person dismisses it.
 */
function EarlierRegistration({ username }: { username: string }) {
  return (
    <div
      data-earlier-registration=""
      className="flex flex-col items-start gap-2 rounded-xl border bg-card p-4 shadow-sm"
    >
      <NeutralStatus kind="status">
        <strong className="font-medium">{EARLIER_HEADING}.</strong>{" "}
        {EARLIER_MESSAGE}
      </NeutralStatus>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => signInRequest.request(username)}>Sign in</Button>
        <Button
          variant="ghost"
          onClick={() => invitationMemory.dismissEarlier()}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/** The way out of a dead end: the sign-in surface, with the username the person chose (never a password). */
function SignInLink({ username = "" }: { username?: string }) {
  return (
    <div>
      <Button variant="default" onClick={() => signInRequest.request(username)}>
        Sign in
      </Button>
    </div>
  );
}
