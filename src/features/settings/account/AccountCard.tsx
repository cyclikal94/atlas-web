import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { useSession } from "../../../session";
import { LoadFailed } from "../sessions-devices/LoadFailed";
import { useLoad } from "../sessions-devices/useLoad";
import { WipeConfirmDialog } from "../sessions-devices/WipeConfirmDialog";
import { accountActions } from "./slots";

/**
 * WF-SETTINGS-01's account card ([D] "Atlas Settings Screens", SETTINGS-01): who is signed in on this browser, since when, and
 * the way out. It reads `GET /me` FRESH every time (never a cache, never derived from an account id) and shows the contract's
 * own `username`, as a username: no display name exists to show (design gaps G-21; the rail's account label stays WEB-08c's).
 * A `closed` or `auth_state` answer means the session view has already switched to a neutral state and this tree is going: the
 * card then renders nothing about any account. "Sign out" opens the same warning as Sessions & devices (`WipeConfirmDialog`).
 */
export const ACCOUNT_HEADING = "Account";

/** "08:57" in the viewer's zone, and the zone's IANA name: [D] "signed in since 08:57 · Europe/London". */
export function sinceLine(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone ? `Signed in since ${time} · ${zone}` : `Signed in since ${time}`;
}

export function AccountCard() {
  const session = useSession();
  const [account, reloadAccount] = useLoad(() =>
    session.operations.readAccount(),
  );
  // Only the current row's start time is wanted; if this read fails the line is simply omitted.
  const [sessions] = useLoad(() => session.operations.listSessions());
  const [loggingOut, setLoggingOut] = useState(false);

  if (
    account.status === "error" &&
    (account.error.cause === "closed" || account.error.cause === "auth_state")
  )
    return null;

  const current =
    sessions.status === "ready"
      ? sessions.value.sessions.find((row) => row.current)
      : undefined;
  const since = current ? sinceLine(current.created_at) : null;

  return (
    <section
      aria-labelledby="account-heading"
      data-account-card=""
      className="flex flex-col gap-3 rounded-row border border-hairline-strong bg-panel p-4"
    >
      <h2 id="account-heading" className="text-[15px] font-medium text-ink-1">
        {ACCOUNT_HEADING}
      </h2>
      {account.status === "loading" ? (
        <div
          aria-busy="true"
          data-skeleton=""
          className="flex items-center gap-3"
        >
          <span className="sr-only">Loading your account…</span>
          <span
            aria-hidden="true"
            className="size-9 motion-safe:animate-pulse rounded-full bg-hairline-strong"
          />
          <span className="flex flex-col gap-1.5" aria-hidden="true">
            <span className="h-3.5 w-32 motion-safe:animate-pulse rounded-control bg-hairline-strong" />
            <span className="h-3 w-48 motion-safe:animate-pulse rounded-control bg-hairline-strong" />
          </span>
        </div>
      ) : account.status === "error" ? (
        <LoadFailed
          what="your account"
          error={account.error}
          onRetry={reloadAccount}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-[13px] font-medium text-ink-1"
          >
            {[...account.value.username][0]?.toUpperCase() ?? ""}
          </span>
          <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
            <p
              data-account-username=""
              className="break-words text-[14px] text-ink-1"
            >
              <span className="sr-only">Signed in as username </span>
              {account.value.username}
            </p>
            {since ? <p className="text-[12.5px] text-ink-2">{since}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {accountActions.map((action) => (
              <span key={action.id}>{action.render()}</span>
            ))}
            <Button onClick={() => setLoggingOut(true)}>Sign out</Button>
          </div>
        </div>
      )}
      {loggingOut ? (
        <WipeConfirmDialog kind="logout" onClose={() => setLoggingOut(false)} />
      ) : null}
    </section>
  );
}
