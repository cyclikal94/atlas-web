import { useEffect, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { List } from "../../components/ui/list";
import { type SnapshotHousehold, useSharingDefaults } from "../../data";
import {
  type Invitation,
  type ManagementCommand,
  type SharingApi,
  type SharingFailure,
  type SharingResult,
  untilSent,
} from "./api";
import * as copy from "./copy";
import { useSharingEnv } from "./env";
import { type Attempt, nextAttempt } from "./model/submission";
import { Banner, formatWhen, useSharingLoad } from "./parts";

/** An attempt whose outcome is not known, with the identity that made it (see `uncertain` below). */
interface Unresolved {
  attempt: Attempt;
  done: string;
  identity: string;
  /** Whether it may have reached the server (an uncertain answer), not only been held back. */
  sent: boolean;
}

/**
 * WEB-12a's DEMONSTRATION subset of household management (delivery-slices: "the household-invitation UI needed only to demonstrate the
 * editor against a real household, not full household management"): your households, create one, invite an existing account by exact
 * username (managers), and "Invitations for you" (accept or decline). WEB-12b owns WF-SHARING-01/02 and replaces or extends this.
 *
 * Online-only. Offline it shows the households this page last read, with THAT read's time, or, before any was read, the households the
 * last sharing snapshot named, with its time and said to be only those (B5 lists the primary household and the households the defaults
 * name, never every membership: an empty one is not "you're not in a household"; design assessment DA-M2). Every action is disabled
 * offline. After any success the households and the sharing defaults are read again (membership moves the defaults' revision).
 */
export function HouseholdsMinimal() {
  const env = useSharingEnv();
  const defaults = useSharingDefaults();
  const announcer = useAnnouncer();
  const ids = { heading: useId(), invitations: useId(), create: useId() };
  const [households, reloadHouseholds] = useSharingLoad(
    () => env.api.readHouseholds(),
    { enabled: env.online, now: env.now, target: [env.api] },
  );
  const [invitations, reloadInvitations] = useSharingLoad(
    () => env.api.readInvitations(),
    { enabled: env.online, now: env.now, target: [env.api] },
  );
  const [problem, setProblem] = useState<{
    message: string;
    requestId?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  /**
   * The attempt whose outcome is not known, for the identity that made it. Its command carries an id this page chose (a household's, an
   * invitation's), so it is never rebuilt: Try again resends it as it is (same key, same body). `sent` says whether it may have reached
   * the server (an uncertain answer) rather than only been held back (`not_sent`). Only a receipt or the server's own refusal ends it: a
   * Try again that is not sent (offline, held back, the session closing) proves nothing about the earlier request, so the attempt is kept
   * and nothing new is sent until it is resolved (R8). Reload shows the households again but does not end it either: a list read is not
   * proof the earlier request cannot still commit. It lives as long as this page (D-12a-2; a reload of the app does not keep it).
   */
  const [uncertain, setUncertainState] = useState<Unresolved | null>(null);
  const held = useRef<Unresolved | null>(null);
  const hold = (next: Unresolved | null) => {
    held.current = next;
    setUncertainState(next);
  };
  /**
   * The one operation that owns sending (with its invite lookup), taken SYNCHRONOUSLY when it is admitted: a second click, a Try again
   * or a lookup's continuation cannot start another command while one is being prepared or sent (DA-H1). `live` is the env of the
   * latest render, so a continuation checks the connection, the server's compatibility and the identity as they are NOW.
   */
  const operation = useRef<{ token: number; identity: string } | null>(null);
  const tokens = useRef(0);
  const live = useRef(env);
  live.current = env;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const failed = (failure: SharingFailure) => {
    if (failure.kind === "closed") return;
    const requestId = "requestId" in failure ? failure.requestId : undefined;
    setProblem({
      message:
        failure.kind === "gone"
          ? copy.INVITATION_EXPIRED
          : failure.kind === "uncertain"
            ? copy.UNCERTAIN
            : failure.kind === "not_sent"
              ? copy.NOT_SENT
              : failure.kind === "offline"
                ? copy.SAVE_OFFLINE_REASON
                : copy.REFUSED(
                    "message" in failure ? failure.message : undefined,
                  ),
      ...(requestId ? { requestId } : {}),
    });
  };

  /** The unresolved attempt of the identity now displayed (one held for another identity is never shown or sent under this one). */
  const unresolved = (): Unresolved | null =>
    held.current !== null && held.current.identity === live.current.identity
      ? held.current
      : null;
  /** Why an operation cannot start now, or null. A new command waits for an unresolved one; a Try again is only for it. */
  const refusal = (retry: boolean): string | null => {
    const now = live.current;
    if (!now.online) return copy.SAVE_OFFLINE_REASON;
    if (!now.writable) return copy.SAVE_COMPAT_REASON;
    if (operation.current !== null) return copy.SAVE_BUSY_REASON;
    if (retry) return unresolved() === null ? copy.UNCERTAIN_PENDING : null;
    return unresolved() !== null ? copy.UNCERTAIN_PENDING : null;
  };
  /** Admits an operation, or returns null. Synchronous: what it checked cannot change before the operation is owned. */
  const admit = (retry: boolean): number | null => {
    if (!mounted.current || refusal(retry) !== null) return null;
    tokens.current += 1;
    operation.current = {
      token: tokens.current,
      identity: live.current.identity,
    };
    setBusy(true);
    setProblem(null);
    return tokens.current;
  };
  /** Whether `token` still owns the page for the identity that started it. */
  const owns = (token: number) =>
    mounted.current &&
    operation.current?.token === token &&
    operation.current.identity === live.current.identity;
  const release = (token: number) => {
    if (operation.current?.token !== token) return;
    operation.current = null;
    if (mounted.current) setBusy(false);
  };

  /**
   * One management command under the admitted operation `token`, idempotent per body (D-12a-2); after a success everything it may have
   * moved is read again. `api` is the client of the identity that admitted it.
   */
  const send = async (
    token: number,
    api: SharingApi,
    attempt: Attempt,
    done: string,
  ) => {
    const result: SharingResult<{ revision: number }> = await untilSent(
      () => api.management(JSON.parse(attempt.body), attempt.key),
      { isCurrent: () => owns(token) },
    );
    if (!owns(token)) {
      // Unmounted, or another identity is displayed: nothing here is for it (the attempt stays with the identity that made it).
      release(token);
      return false;
    }
    release(token);
    const identity = live.current.identity;
    // The unresolved attempt this send was a Try again of, if it was one.
    const earlier =
      unresolved()?.attempt.key === attempt.key ? unresolved() : null;
    if (result.ok) {
      if (earlier !== null) hold(null);
      announcer.announce(done);
      reloadHouseholds();
      reloadInvitations();
      // Asked AFTER the change (R7): a snapshot read already under way may predate it.
      void defaults.acquire(defaults.boundary());
      return true;
    }
    switch (result.kind) {
      case "uncertain":
        hold({ attempt, done, identity, sent: true });
        break;
      case "not_sent":
        hold({ attempt, done, identity, sent: earlier?.sent === true });
        break;
      case "offline":
      case "closed":
        // Not sent this time: an earlier attempt that may have committed stays exactly as it was (R8). A first attempt was never sent.
        if (earlier !== null) {
          setProblem({
            message: earlier.sent ? copy.UNCERTAIN : copy.NOT_SENT,
          });
          return false;
        }
        break;
      default:
        // The server's own refusal of this key and body: it was not made.
        if (earlier !== null) hold(null);
    }
    failed(result);
    return false;
  };

  const run = (command: ManagementCommand, done: string) => {
    const token = admit(false);
    if (token === null) return Promise.resolve(false);
    return send(
      token,
      live.current.api,
      nextAttempt(null, [command], env.newId),
      done,
    );
  };
  const retry = () => {
    const earlier = unresolved();
    const token = earlier === null ? null : admit(true);
    if (earlier === null || token === null) return;
    void send(token, live.current.api, earlier.attempt, earlier.done);
  };
  const invite = async (household: SnapshotHousehold, username: string) => {
    // The lookup is part of the operation: the page is owned from the click, so nothing else is sent while the answer is awaited.
    const token = admit(false);
    if (token === null) return false;
    const api = live.current.api;
    const found = await untilSent(() => api.lookup(username), {
      isCurrent: () => owns(token),
    });
    if (!owns(token)) {
      release(token);
      return false;
    }
    const reason = !live.current.online
      ? copy.SAVE_OFFLINE_REASON
      : !live.current.writable
        ? copy.SAVE_COMPAT_REASON
        : null;
    if (reason !== null) {
      release(token);
      setProblem({ message: reason });
      return false;
    }
    const match = found.ok
      ? found.value.find((entry) => entry.username === username)
      : undefined;
    if (!found.ok || match === undefined) {
      release(token);
      if (!found.ok) failed(found);
      else setProblem({ message: copy.INVITE_NOT_FOUND });
      return false;
    }
    return send(
      token,
      api,
      nextAttempt(
        null,
        [
          {
            kind: "invite_to_household",
            id: env.newId(),
            household_id: household.id,
            recipient_id: match.id,
            expected_version: household.version,
          },
        ],
        env.newId,
      ),
      copy.INVITED,
    );
  };

  const shownUncertain =
    uncertain !== null && uncertain.identity === env.identity
      ? uncertain
      : null;
  const blocked = !env.online
    ? copy.SAVE_OFFLINE_REASON
    : !env.writable
      ? copy.SAVE_COMPAT_REASON
      : busy
        ? copy.SAVE_BUSY_REASON
        : shownUncertain !== null
          ? copy.UNCERTAIN_PENDING
          : null;
  const retryBlocked = !env.online
    ? copy.SAVE_OFFLINE_REASON
    : !env.writable
      ? copy.SAVE_COMPAT_REASON
      : busy
        ? copy.SAVE_BUSY_REASON
        : null;
  const nameLength = [...name.trim()].length;

  // What is listed, with its scope and its own time (design assessment DA-M2): the complete list this page read (`GET /households`), or,
  // offline before it was read, the households the last B5 snapshot recorded: only the primary household and those the defaults name.
  const shown: {
    from: "complete" | "snapshot";
    list: SnapshotHousehold[];
    at: number;
  } | null =
    households.status === "ready"
      ? { from: "complete", list: households.value, at: households.at }
      : !env.online && defaults.record
        ? {
            from: "snapshot",
            list: defaults.record.snapshot.households,
            at: defaults.record.fetched_at,
          }
        : null;
  const primaryId =
    defaults.record?.snapshot.defaults.primary_household_id ?? null;

  return (
    <section
      aria-labelledby={ids.heading}
      className="flex flex-col gap-4"
      data-households=""
    >
      <div className="flex flex-col gap-1">
        <h2 id={ids.heading} className="text-lg font-medium text-foreground">
          {copy.HOUSEHOLDS_HEADING}
        </h2>
        <p className="text-xs text-muted-foreground">
          {copy.HOUSEHOLDS_SUBSET_NOTE}
        </p>
      </div>
      {problem ? (
        <Banner
          message={problem.message}
          requestId={problem.requestId}
          action={
            shownUncertain !== null ? (
              <span className="flex flex-wrap gap-2">
                {retryBlocked !== null ? (
                  <Button disabled reason={retryBlocked}>
                    {copy.TRY_AGAIN}
                  </Button>
                ) : (
                  <Button onClick={retry}>{copy.TRY_AGAIN}</Button>
                )}
                <Button
                  variant="ghost"
                  onClick={() => {
                    // Shows the households and invitations again; the unconfirmed change stays to be tried again (R8).
                    reloadHouseholds();
                    reloadInvitations();
                  }}
                >
                  {copy.RELOAD}
                </Button>
              </span>
            ) : undefined
          }
        />
      ) : null}
      {households.status === "failed" ? (
        <Banner
          message={copy.HOUSEHOLDS_FAILED}
          requestId={
            "requestId" in households.failure
              ? households.failure.requestId
              : undefined
          }
          action={<Button onClick={reloadHouseholds}>{copy.TRY_AGAIN}</Button>}
        />
      ) : shown === null ? (
        <p className="text-sm text-muted-foreground">
          {env.online ? copy.HOUSEHOLDS_LOADING : copy.HOUSEHOLDS_OFFLINE_NONE}
        </p>
      ) : shown.from === "snapshot" && shown.list.length === 0 ? (
        // B5 names no household: that is not "you're in none" (DA-M2).
        <div className="flex flex-col gap-1" data-households-from="snapshot">
          <p className="text-sm text-foreground">
            {copy.HOUSEHOLDS_SNAPSHOT_NONE}
          </p>
          <p className="text-xs text-muted-foreground">
            {copy.AS_OF(formatWhen(shown.at, env.now()))}
          </p>
        </div>
      ) : (
        <>
          {!env.online ? (
            <p
              className="text-xs text-muted-foreground"
              data-households-from={shown.from}
            >
              {shown.from === "snapshot"
                ? `${copy.HOUSEHOLDS_FROM_SNAPSHOT} ${copy.AS_OF(formatWhen(shown.at, env.now()))}`
                : copy.HOUSEHOLDS_LAST_READ(formatWhen(shown.at, env.now()))}
            </p>
          ) : null}
          {shown.list.length === 0 ? (
            // Only the complete list can say this (DA-M2).
            <p className="text-sm text-foreground">{copy.HOUSEHOLDS_EMPTY}</p>
          ) : (
            <List className="flex flex-col gap-2">
              {shown.list.map((household) => (
                <HouseholdRow
                  key={household.id}
                  household={household}
                  primary={household.id === primaryId}
                  blocked={blocked}
                  onInvite={(username) => invite(household, username)}
                />
              ))}
            </List>
          )}
        </>
      )}
      <form
        aria-labelledby={ids.create}
        className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (blocked !== null || nameLength < 1 || nameLength > 300) return;
          void run(
            { kind: "create_household", id: env.newId(), name: name.trim() },
            copy.CREATED,
          ).then((ok) => {
            if (ok && mounted.current) setName("");
          });
        }}
      >
        <h3 id={ids.create} className="text-sm font-medium text-foreground">
          {copy.CREATE_HEADING}
        </h3>
        <Input
          label={copy.CREATE_NAME}
          value={name}
          maxLength={300}
          onChange={(event) => setName(event.target.value)}
        />
        <span>
          {blocked !== null ? (
            <Button variant="default" disabled reason={blocked}>
              {copy.CREATE_BUTTON}
            </Button>
          ) : nameLength < 1 || nameLength > 300 ? (
            <Button variant="default" disabled reason={copy.CREATE_NAME_REASON}>
              {copy.CREATE_BUTTON}
            </Button>
          ) : (
            <Button variant="default" type="submit">
              {copy.CREATE_BUTTON}
            </Button>
          )}
        </span>
      </form>
      <section
        aria-labelledby={ids.invitations}
        className="flex flex-col gap-2"
      >
        <h3
          id={ids.invitations}
          className="text-sm font-medium text-foreground"
        >
          {copy.INVITATIONS_HEADING}
        </h3>
        {invitations.status === "ready" ? (
          <InvitationList
            invitations={invitations.value.filter(
              (i) => i.status === "pending",
            )}
            blocked={blocked}
            now={env.now()}
            onRespond={(invitation, accept) =>
              void run(
                {
                  kind: "respond_to_household_invitation",
                  id: invitation.id,
                  expected_version: invitation.version,
                  accept,
                },
                accept ? copy.ACCEPTED : copy.DECLINED,
              )
            }
          />
        ) : invitations.status === "failed" ? (
          <Banner
            message={copy.HOUSEHOLDS_FAILED}
            action={
              <Button onClick={reloadInvitations}>{copy.TRY_AGAIN}</Button>
            }
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {env.online
              ? copy.HOUSEHOLDS_LOADING
              : copy.LOOKUP_NEEDS_CONNECTION}
          </p>
        )}
      </section>
    </section>
  );
}

function HouseholdRow({
  household,
  primary,
  blocked,
  onInvite,
}: {
  household: SnapshotHousehold;
  primary: boolean;
  blocked: string | null;
  onInvite(username: string): Promise<boolean>;
}) {
  const [username, setUsername] = useState("");
  return (
    <li
      data-household={household.id}
      className="flex list-none flex-col gap-2 rounded-lg border border-border bg-card p-3.5"
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">
          {household.name}
        </span>
        {primary ? (
          <span className="rounded-sm border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
            {copy.PRIMARY_BADGE}
          </span>
        ) : null}
      </span>
      <span className="text-xs text-muted-foreground">
        {copy.HOUSEHOLD_ROLE(household.role)} ·{" "}
        {copy.HOUSEHOLD_MEMBERS(household.members.length)}:{" "}
        {household.members.map((member) => member.username).join(", ")}
      </span>
      {household.role === "manager" ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (blocked !== null || username.trim() === "") return;
            void onInvite(username.trim()).then((ok) => {
              if (ok) setUsername("");
            });
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              label={copy.INVITE_LABEL(household.name)}
              value={username}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          {blocked !== null ? (
            <Button disabled reason={blocked}>
              {copy.INVITE_BUTTON}
            </Button>
          ) : username.trim() === "" ? (
            <Button disabled reason={copy.INVITE_REASON}>
              {copy.INVITE_BUTTON}
            </Button>
          ) : (
            <Button type="submit">{copy.INVITE_BUTTON}</Button>
          )}
        </form>
      ) : null}
    </li>
  );
}

function InvitationList({
  invitations,
  blocked,
  now,
  onRespond,
}: {
  invitations: Invitation[];
  blocked: string | null;
  now: number;
  onRespond(invitation: Invitation, accept: boolean): void;
}) {
  if (invitations.length === 0)
    return <p className="text-sm text-foreground">{copy.INVITATIONS_EMPTY}</p>;
  return (
    <List className="flex flex-col gap-2">
      {invitations.map((invitation) => {
        const expires = Date.parse(invitation.expires_at);
        return (
          <li
            key={invitation.id}
            data-invitation={invitation.id}
            className="flex list-none flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3"
          >
            <span className="min-w-0 flex-1 text-sm text-foreground">
              {copy.INVITATION_FROM(
                invitation.household_name,
                Number.isNaN(expires)
                  ? invitation.expires_at
                  : formatWhen(expires, now),
              )}
            </span>
            {blocked !== null ? (
              <Button disabled reason={blocked}>
                {copy.ACCEPT}
              </Button>
            ) : (
              <>
                <Button
                  aria-label={`${copy.DECLINE}: ${invitation.household_name}`}
                  onClick={() => onRespond(invitation, false)}
                >
                  {copy.DECLINE}
                </Button>
                <Button
                  variant="default"
                  aria-label={`${copy.ACCEPT}: ${invitation.household_name}`}
                  onClick={() => onRespond(invitation, true)}
                >
                  {copy.ACCEPT}
                </Button>
              </>
            )}
          </li>
        );
      })}
    </List>
  );
}
