import { useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import { type AccountSummary, useSession } from "../../../session";
import { startSso } from "../../authentication/controller";
import { RequestId } from "../../authentication/MessageText";
import { MESSAGE_TEXT } from "../../authentication/outcome-copy";
import { isOnlineNow, useOnline } from "../../authentication/use-online";
import { useInteractions } from "../sessions-devices/ownership";
import { untilSent } from "../sessions-devices/until-sent";
import { leavesOutcomeUnknown } from "./outcome";
import { Unconfirmed } from "./Unconfirmed";
import { useStaleSession } from "./use-stale-session";

/** [D] SETTINGS-03, "Linked accounts". */
export const LINKED_HEADING = "Linked accounts";
/**
 * [D] with the cause-naming clause dropped (design gap G-18): the sign-in screen after a removal is a neutral state, which names
 * no cause because it must show nothing about any account.
 */
export const REMOVE_CONSEQUENCE =
  "Removing this also signs you out everywhere. You'll come back to a sign-in screen.";
/** [D] the five-minute rule, expressed as the reason it exists. */
export const REMOVE_RULE =
  "You can only remove it in the first few minutes after signing in, and only while you have a password to fall back on — otherwise you'd have no way back in.";
/** [P] (gap G-19): there is no accepted wireframe for the link control. */
export const LINK_LABEL = "Link single sign-on";
export const LINK_HINT =
  "You'll go to your provider and come back here. This needs a sign-in from the last few minutes.";
export const NO_LINKS = "No single sign-on is linked to this account.";
export const STALE_REASON =
  "Needs a sign-in from the last few minutes. Sign out and in again first.";
export const NO_PASSWORD_REASON = "You need a password of your own first.";
/** [P], review R7: no accepted wording exists for the offline state; the sibling reasons are one sentence of this shape. */
export const REMOVE_OFFLINE_REASON =
  "Removing a single sign-on link needs a connection.";
export const LINK_OFFLINE_REASON = "Linking single sign-on needs a connection.";

/** An issuer is shown as TEXT only: its host, or the string itself clipped. Never a link, never markup (E-33). */
export function issuerLabel(issuer: string): string {
  try {
    const host = new URL(issuer).host;
    if (host) return host.length > 80 ? `${host.slice(0, 79)}…` : host;
  } catch {
    // Not a URL: fall through to the raw string.
  }
  return issuer.length > 80 ? `${issuer.slice(0, 79)}…` : issuer;
}

const browserNavigate = (url: string) => location.assign(url);

/**
 * "Linked accounts": one row per issuer from `GET /me` (the contract has no link date and no provider name, so neither is
 * shown), Remove, and Link. Remove and Link need a session created within five minutes, which the page checks against the
 * current session's own start time so the normal case never provokes the server's refusal; a skewed clock can still reach it,
 * and a `401` fails closed (gap G-23). That check does not end when the screen opens (review R8): the controls disable themselves
 * when the window ends while the screen stays open, and each handler reads the clock again before it starts anything. Remove
 * also needs a password of your own. Neither success draws anything: removal ends the session (the neutral state takes over)
 * and a link leaves the page for the provider.
 *
 * Both need a connection (review R7): while the browser reports none they are disabled with their reason and their handlers
 * refuse to start. That is a hint, never the evidence for an outcome: a removal that started online is judged by its answer, and
 * an answer that cannot show the removal was not made (a lost one, or a `5xx`) is unconfirmed (review R6), because removal ends
 * the session in the same transaction and a retry could not authenticate.
 */
export function LinkedIdentities({
  account,
  currentSessionStartedAt,
  navigate = browserNavigate,
}: {
  account: AccountSummary;
  /** The current session's `created_at`, or null when it could not be read (the server then decides). */
  currentSessionStartedAt: string | null;
  navigate?(url: string): void;
}) {
  const session = useSession();
  const interactions = useInteractions();
  const online = useOnline();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{
    for: string;
    text: string;
    requestId?: string;
  } | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const headingId = useId();
  // WF-SETTINGS-03 (states.md, "Removed"): the sign-out-everywhere consequence is disclosed BEFORE Remove and is associated with
  // the button through `aria-describedby`, on the mobile sheet as well as the desktop dialog (one component serves both).
  const consequenceId = useId();
  const { stale, recheck } = useStaleSession(currentSessionStartedAt);

  const remove = async (issuer: string) => {
    if (!online || !isOnlineNow() || recheck()) return;
    setBusy(issuer);
    setProblem(null);
    // WEB-08d review R3: retried only while this screen is mounted; leaving it withdraws a removal still waiting to be issued.
    const interaction = interactions.begin();
    const result = await untilSent(
      () =>
        session.operations.unlinkOidc(issuer, {
          withdraw: interaction.withdraw,
        }),
      { isCurrent: interaction.current },
    ).catch(() => null);
    interaction.end();
    setBusy(null);
    if (result === null || leavesOutcomeUnknown(result))
      return setUnconfirmed(true);
    if (result.ok) return;
    if (result.error === "auth_state" || result.error === "closed") return;
    setProblem({
      for: issuer,
      text: MESSAGE_TEXT[
        result.error === "not_sent" ? "busy_window" : "unlink_refused"
      ],
    });
  };

  const link = async () => {
    if (!online || !isOnlineNow() || recheck()) return;
    setBusy("link");
    setProblem(null);
    const result = await startSso(session, { link: true }, { navigate });
    setBusy(null);
    if (result.kind === "failed")
      setProblem({
        for: "link",
        text: MESSAGE_TEXT[result.message.id],
        requestId: result.message.requestId,
      });
  };

  // What is true now comes first, then what has to be true before the control can ever work: while there is no connection that
  // is the thing to fix, and the other reason is still there to read when it returns.
  const removeReason = !online
    ? REMOVE_OFFLINE_REASON
    : !account.has_password
      ? NO_PASSWORD_REASON
      : stale
        ? STALE_REASON
        : null;
  const linkReason = !online
    ? LINK_OFFLINE_REASON
    : stale
      ? STALE_REASON
      : null;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3"
      data-linked=""
    >
      <h3 id={headingId} className="text-[14px] font-medium text-ink-1">
        {LINKED_HEADING}
      </h3>
      {account.oidc_issuers.length === 0 ? (
        <p className="text-[13px] text-ink-2">{NO_LINKS}</p>
      ) : (
        <List className="flex flex-col gap-2">
          {account.oidc_issuers.map((issuer) => (
            <li
              key={issuer}
              data-issuer-row=""
              className="list-none rounded-row border border-hairline-strong bg-panel p-3"
            >
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                {/* The host takes the room it needs and the control wraps below it, so a host is only broken inside a word when
                    it is longer than the row (`break-words`), never because a neighbour squeezed it. */}
                <span className="flex min-w-0 flex-1 basis-48 items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="shrink-0 rounded-control border border-hairline-strong px-1.5 py-0.5 text-[11px] text-ink-2"
                  >
                    SSO
                  </span>
                  <span
                    data-issuer=""
                    className="min-w-0 break-words text-[14px] text-ink-1"
                  >
                    {issuerLabel(issuer)}
                  </span>
                </span>
                {busy === issuer ? (
                  <Button
                    disabled
                    reason="Removing…"
                    aria-describedby={consequenceId}
                  >
                    Remove
                  </Button>
                ) : removeReason ? (
                  <Button
                    disabled
                    reason={removeReason}
                    aria-describedby={consequenceId}
                  >
                    Remove
                  </Button>
                ) : (
                  <Button
                    aria-label={`Remove ${issuerLabel(issuer)}`}
                    aria-describedby={consequenceId}
                    onClick={() => void remove(issuer)}
                  >
                    Remove
                  </Button>
                )}
              </div>
              {problem?.for === issuer ? (
                <p
                  data-error=""
                  className="mt-2 text-[12.5px] leading-[1.6] text-ink-1"
                >
                  {problem.text}
                </p>
              ) : null}
            </li>
          ))}
        </List>
      )}
      {account.oidc_issuers.length > 0 ? (
        <>
          <p
            id={consequenceId}
            data-remove-consequence=""
            className="text-[12.5px] leading-[1.6] text-ink-2"
          >
            {REMOVE_CONSEQUENCE}
          </p>
          <p className="text-[12.5px] leading-[1.6] text-ink-2">
            {REMOVE_RULE}
          </p>
        </>
      ) : null}
      {unconfirmed ? (
        <Unconfirmed check={() => session.operations.readAccount()} />
      ) : null}
      <div className="flex flex-col items-start gap-2">
        {busy === "link" ? (
          <Button disabled reason="Opening your provider…">
            {LINK_LABEL}
          </Button>
        ) : linkReason ? (
          <Button disabled reason={linkReason}>
            {LINK_LABEL}
          </Button>
        ) : (
          <Button onClick={() => void link()}>{LINK_LABEL}</Button>
        )}
        <p className="text-[12.5px] leading-[1.6] text-ink-2">{LINK_HINT}</p>
        {problem?.for === "link" ? (
          <p data-error="" className="text-[12.5px] leading-[1.6] text-ink-1">
            {problem.text}
            <RequestId id={problem.requestId} />
          </p>
        ) : null}
      </div>
    </section>
  );
}
