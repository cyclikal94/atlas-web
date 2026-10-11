import { useEffect, useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import { type SessionSummary, useSession } from "../../../session";
import { formatAgo, formatIn } from "../relative-time";
import { CapacityLine } from "./CapacityLine";
import { LoadFailed } from "./LoadFailed";
import {
  ON_DEVICE,
  SIGN_IN_ENDED,
  signedOut,
  signOutFailed,
  THIS_BROWSER_TAG,
} from "./label-copy";
import {
  decodeClientLabel,
  decodeDeviceName,
  sessionInSentence,
  sessionPhrase,
  sessionTitle,
} from "./labels";
import { outcomeUnknown } from "./outcome";
import { untilSent } from "./until-sent";
import { useLoad } from "./useLoad";

/**
 * "Where you're signed in" (WF-SETTINGS-02). WEB-08d: a row is titled by the BE-Q25 client label ("Chrome on macOS"), with WEB-08a's
 * "This browser" / "Another sign-in" as the fallback for a legacy, absent or unusable label; its device's name, how it authenticates,
 * and when it started and ends tell rows apart without an identifier. The live-session capacity is the answer's own.
 */
export const SESSIONS_HEADING = "Where you're signed in";
export const SESSIONS_CONSEQUENCE =
  "Ending one of these signs that browser out. It doesn't change syncing.";
export const CURRENT_NOTE =
  "Signing out here ends your current session immediately — you'll need to log in again.";
export const REVOKE_FAILED = "Couldn't revoke this session — please try again.";

export const sessionMeta = (row: SessionSummary, now: Date): string =>
  [
    row.authentication === "oidc" ? "Single sign-on" : "Password",
    `Signed in ${formatAgo(row.created_at, now)}`,
    `Expires ${formatIn(row.expires_at, now)}`,
  ].join(" · ");

export function SessionsSection({
  onSignOutCurrent,
  refresh = 0,
  onChanged,
}: {
  /** Opens the logout warning for the current row (the row is passed so the warning can name it). */
  onSignOutCurrent(row: SessionSummary): void;
  /** Changes when the server may have changed what this list shows (in either section): the list is read again. */
  refresh?: number;
  /**
   * A sign-out here was confirmed, or its outcome is unknown: the devices list changes too (a never-synced device leaves with its
   * last session; a synced one's session count drops). The owner reads both lists again; without one, this list reloads itself.
   */
  onChanged?(): void;
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
  const lastRefresh = useRef(refresh);
  useEffect(() => {
    if (lastRefresh.current === refresh) return;
    lastRefresh.current = refresh;
    reload();
  }, [refresh, reload]);
  const changed = () => (onChanged ? onChanged() : reload());

  const revoke = async (row: SessionSummary) => {
    const id = row.id;
    setBusy(id);
    setFailed(null);
    const result = await untilSent(() =>
      session.operations.revokeOtherSession(id),
    ).catch(() => null);
    setBusy(null);
    const named = decodeClientLabel(row.client) !== null;
    if (result?.ok) {
      announcer.announce(
        named ? signedOut(sessionInSentence(row)) : SIGN_IN_ENDED,
      );
      changed();
      return;
    }
    setFailed({
      id,
      requestId:
        result && !result.ok ? result.atlasError?.request_id : undefined,
    });
    announcer.announce(
      named ? signOutFailed(sessionInSentence(row)) : REVOKE_FAILED,
      "assertive",
    );
    // The session may have ended anyway (an answer lost after sending, a server error): read again. The row's failure stays shown
    // while it is still listed, and signing it out again is safe (an ended session answers `gone`).
    if (outcomeUnknown(result)) changed();
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
        {load.status === "ready" ? (
          <CapacityLine kind="sessions" raw={load.value.session_capacity} />
        ) : null}
      </div>
      {load.status === "loading" ? (
        <p aria-busy="true" className="text-[13px] text-ink-2">
          Loading your sign-ins…
        </p>
      ) : load.status === "error" ? (
        <LoadFailed what="your sign-ins" error={load.error} onRetry={reload} />
      ) : (
        <List className="flex flex-col gap-2">
          {load.value.sessions.map((row) => {
            const device = decodeDeviceName(row.device_name);
            const label = `Sign out ${sessionPhrase(row, now)}`;
            return (
              <li
                key={row.id}
                data-session-row={row.current ? "current" : "other"}
                className="list-none rounded-row border border-hairline-strong bg-panel p-3.5"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[14px] text-ink-1 [overflow-wrap:anywhere]">
                      {sessionTitle(row)}
                      {row.current ? (
                        <span
                          data-current-tag=""
                          className="ml-2 text-[12px] text-ink-2"
                        >
                          {THIS_BROWSER_TAG}
                        </span>
                      ) : null}
                    </span>
                    {device !== null ? (
                      <span
                        data-device-name=""
                        className="text-[12.5px] text-ink-2 [overflow-wrap:anywhere]"
                      >
                        {ON_DEVICE} <bdi>{device}</bdi>
                      </span>
                    ) : null}
                    <span className="text-[12.5px] text-ink-2">
                      {sessionMeta(row, now)}
                    </span>
                  </div>
                  {row.current ? (
                    <Button
                      aria-label={label}
                      onClick={() => onSignOutCurrent(row)}
                    >
                      Sign out
                    </Button>
                  ) : busy === row.id ? (
                    <Button disabled reason="Working…" aria-label={label}>
                      Sign out
                    </Button>
                  ) : (
                    <Button aria-label={label} onClick={() => void revoke(row)}>
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
            );
          })}
        </List>
      )}
    </section>
  );
}
