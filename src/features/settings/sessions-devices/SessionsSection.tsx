import { useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import { type SessionSummary, useSession } from "../../../session";
import { formatAgo, formatIn } from "../relative-time";
import { LoadFailed } from "./LoadFailed";
import { untilSent } from "./until-sent";
import { useLoad } from "./useLoad";

/**
 * "Where you're signed in" (WF-SETTINGS-02). Labels come from real fields only (design gap G-1): the contract carries no
 * user-agent or label, so a row says "This browser" or "Another sign-in", how it authenticates, and when it started and ends.
 */
export const SESSIONS_HEADING = "Where you're signed in";
export const SESSIONS_CONSEQUENCE =
  "Ending one of these signs that browser out. It doesn't change syncing.";
export const CURRENT_NOTE =
  "Signing out here ends your current session immediately — you'll need to log in again.";
export const REVOKE_FAILED = "Couldn't revoke this session — please try again.";

export const sessionTitle = (row: SessionSummary): string =>
  row.current ? "This browser" : "Another sign-in";
export const sessionMeta = (row: SessionSummary, now: Date): string =>
  [
    row.authentication === "oidc" ? "Single sign-on" : "Password",
    `Signed in ${formatAgo(row.created_at, now)}`,
    `Expires ${formatIn(row.expires_at, now)}`,
  ].join(" · ");

export function SessionsSection({
  onSignOutCurrent,
}: {
  onSignOutCurrent(): void;
}) {
  const session = useSession();
  const announcer = useAnnouncer();
  const [load, reload] = useLoad(() => session.operations.listSessions());
  const [failed, setFailed] = useState<{
    id: string;
    requestId?: string;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const now = new Date();

  const revoke = async (id: string) => {
    setBusy(id);
    setFailed(null);
    const result = await untilSent(() =>
      session.operations.revokeOtherSession(id),
    ).catch(() => null);
    setBusy(null);
    if (result?.ok) {
      announcer.announce("That sign-in was ended.");
      reload();
      return;
    }
    setFailed({
      id,
      requestId:
        result && !result.ok ? result.atlasError?.request_id : undefined,
    });
    announcer.announce(REVOKE_FAILED, "assertive");
  };

  return (
    <section
      aria-labelledby="sessions-heading"
      className="flex max-w-[700px] flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <h2
          id="sessions-heading"
          className="text-[15px] font-medium text-ink-1"
        >
          {SESSIONS_HEADING}
        </h2>
        <p className="text-[12.5px] leading-[1.6] text-ink-2">
          {SESSIONS_CONSEQUENCE}
        </p>
      </div>
      {load.status === "loading" ? (
        <p aria-busy="true" className="text-[13px] text-ink-2">
          Loading your sign-ins…
        </p>
      ) : load.status === "error" ? (
        <LoadFailed what="your sign-ins" error={load.error} onRetry={reload} />
      ) : (
        <List className="flex flex-col gap-2">
          {load.value.sessions.map((row) => (
            <li
              key={row.id}
              data-session-row={row.current ? "current" : "other"}
              className="list-none rounded-row border border-hairline-strong bg-panel p-3.5"
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[14px] text-ink-1">
                    {sessionTitle(row)}
                    {row.current ? (
                      <span className="ml-2 text-[12px] text-ink-2">
                        Current session
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[12.5px] text-ink-2">
                    {sessionMeta(row, now)}
                  </span>
                </div>
                {row.current ? (
                  <Button onClick={onSignOutCurrent}>Sign out</Button>
                ) : busy === row.id ? (
                  <Button disabled reason="Working…">
                    Sign out
                  </Button>
                ) : (
                  <Button
                    aria-label="Sign out this other sign-in"
                    onClick={() => void revoke(row.id)}
                  >
                    Sign out
                  </Button>
                )}
              </div>
              {row.current ? (
                <p className="mt-2 text-[12.5px] leading-[1.6] text-ink-2">
                  {CURRENT_NOTE}
                </p>
              ) : null}
              {failed?.id === row.id ? (
                <p data-error="" className="mt-2 text-[12.5px] text-ink-1">
                  {REVOKE_FAILED}
                  {failed.requestId ? ` Request ID: ${failed.requestId}` : ""}
                </p>
              ) : null}
            </li>
          ))}
        </List>
      )}
    </section>
  );
}
