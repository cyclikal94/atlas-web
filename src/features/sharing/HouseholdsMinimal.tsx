import { useEffect, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { List } from "../../components/ui/list";
import { type SnapshotHousehold, useSharingDefaults } from "../../data";
import {
  type Invitation,
  type ManagementCommand,
  type SharingFailure,
  type SharingResult,
  untilSent,
} from "./api";
import * as copy from "./copy";
import { useSharingEnv } from "./env";
import { type Attempt, nextAttempt } from "./model/submission";
import { Banner, formatWhen, useSharingLoad } from "./parts";

/**
 * WEB-12a's DEMONSTRATION subset of household management (delivery-slices: "the household-invitation UI needed only to demonstrate the
 * editor against a real household, not full household management"): your households, create one, invite an existing account by exact
 * username (managers), and "Invitations for you" (accept or decline). WEB-12b owns WF-SHARING-01/02 and replaces or extends this.
 *
 * Online-only. Offline it shows the households of the last sharing snapshot, with its time, and every action disabled. After any
 * success the households and the sharing defaults are read again (membership moves the defaults' revision).
 */
export function HouseholdsMinimal() {
  const env = useSharingEnv();
  const defaults = useSharingDefaults();
  const announcer = useAnnouncer();
  const ids = { heading: useId(), invitations: useId(), create: useId() };
  const [households, reloadHouseholds] = useSharingLoad(
    () => env.api.readHouseholds(),
    { enabled: env.online, now: env.now },
  );
  const [invitations, reloadInvitations] = useSharingLoad(
    () => env.api.readInvitations(),
    { enabled: env.online, now: env.now },
  );
  const [problem, setProblem] = useState<{
    message: string;
    requestId?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  /**
   * An attempt whose outcome is not known (it may have committed). Its command carries an id this page chose (a household's, an
   * invitation's), so it is never rebuilt: Try again resends it as it is (same key, same body), and nothing new is sent until it is
   * resolved or the person reloads to see what happened.
   */
  const [uncertain, setUncertain] = useState<{
    attempt: Attempt;
    done: string;
  } | null>(null);
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

  /** One management command, idempotent per body (D-12a-2); after a success everything it may have moved is read again. */
  const run = (command: ManagementCommand, done: string) =>
    send(nextAttempt(null, [command], env.newId), done);
  const send = async (attempt: Attempt, done: string) => {
    setBusy(true);
    setProblem(null);
    const result: SharingResult<{ revision: number }> = await untilSent(
      () => env.api.management(JSON.parse(attempt.body), attempt.key),
      { isCurrent: () => mounted.current },
    );
    if (!mounted.current) return false;
    setBusy(false);
    if (result.ok) {
      setUncertain(null);
      announcer.announce(done);
      reloadHouseholds();
      reloadInvitations();
      void defaults.refresh();
      return true;
    }
    setUncertain(
      result.kind === "uncertain" || result.kind === "not_sent"
        ? { attempt, done }
        : null,
    );
    failed(result);
    return false;
  };

  const blocked = !env.online
    ? copy.SAVE_OFFLINE_REASON
    : !env.writable
      ? copy.SAVE_COMPAT_REASON
      : busy
        ? copy.SAVE_BUSY_REASON
        : uncertain !== null
          ? copy.UNCERTAIN_PENDING
          : null;
  const nameLength = [...name.trim()].length;

  const shown: SnapshotHousehold[] | null =
    households.status === "ready"
      ? households.value
      : !env.online
        ? (defaults.record?.snapshot.households ?? null)
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
        <h2 id={ids.heading} className="text-[17px] font-medium text-ink-1">
          {copy.HOUSEHOLDS_HEADING}
        </h2>
        <p className="text-[12.5px] text-ink-2">
          {copy.HOUSEHOLDS_SUBSET_NOTE}
        </p>
      </div>
      {problem ? (
        <Banner
          message={problem.message}
          requestId={problem.requestId}
          action={
            uncertain !== null ? (
              <span className="flex flex-wrap gap-2">
                <Button
                  onClick={() => void send(uncertain.attempt, uncertain.done)}
                >
                  {copy.TRY_AGAIN}
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => {
                    setUncertain(null);
                    setProblem(null);
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
        <p className="text-[13px] text-ink-2">
          {env.online ? copy.HOUSEHOLDS_LOADING : copy.HOUSEHOLDS_OFFLINE_NONE}
        </p>
      ) : shown.length === 0 ? (
        <p className="text-[13px] text-ink-1">{copy.HOUSEHOLDS_EMPTY}</p>
      ) : (
        <>
          {!env.online && defaults.record ? (
            <p className="text-[12px] text-ink-2">
              {copy.AS_OF(formatWhen(defaults.record.fetched_at, env.now()))}
            </p>
          ) : null}
          <List className="flex flex-col gap-2">
            {shown.map((household) => (
              <HouseholdRow
                key={household.id}
                household={household}
                primary={household.id === primaryId}
                blocked={blocked}
                onInvite={async (username) => {
                  const found = await untilSent(() => env.api.lookup(username));
                  if (!mounted.current) return false;
                  const match = found.ok
                    ? found.value.find((entry) => entry.username === username)
                    : undefined;
                  if (!found.ok) {
                    failed(found);
                    return false;
                  }
                  if (match === undefined) {
                    setProblem({ message: copy.INVITE_NOT_FOUND });
                    return false;
                  }
                  return run(
                    {
                      kind: "invite_to_household",
                      id: env.newId(),
                      household_id: household.id,
                      recipient_id: match.id,
                      expected_version: household.version,
                    },
                    copy.INVITED,
                  );
                }}
              />
            ))}
          </List>
        </>
      )}
      <form
        aria-labelledby={ids.create}
        className="flex flex-col gap-2 rounded-row border border-hairline-strong bg-panel p-3.5"
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
        <h3 id={ids.create} className="text-[13.5px] font-medium text-ink-1">
          {copy.CREATE_HEADING}
        </h3>
        <Input
          label={copy.CREATE_NAME}
          surface="panel"
          value={name}
          maxLength={300}
          onChange={(event) => setName(event.target.value)}
        />
        <span>
          {blocked !== null ? (
            <Button variant="primary" disabled reason={blocked}>
              {copy.CREATE_BUTTON}
            </Button>
          ) : nameLength < 1 || nameLength > 300 ? (
            <Button variant="primary" disabled reason={copy.CREATE_NAME_REASON}>
              {copy.CREATE_BUTTON}
            </Button>
          ) : (
            <Button variant="primary" type="submit">
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
          className="text-[13.5px] font-medium text-ink-1"
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
          <p className="text-[13px] text-ink-2">
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
      className="flex list-none flex-col gap-2 rounded-row border border-hairline-strong bg-panel p-3.5"
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-medium text-ink-1">
          {household.name}
        </span>
        {primary ? (
          <span className="rounded-badge border border-hairline-strong px-1.5 py-0.5 text-[11.5px] text-ink-2">
            {copy.PRIMARY_BADGE}
          </span>
        ) : null}
      </span>
      <span className="text-[12.5px] text-ink-2">
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
              surface="panel"
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
    return <p className="text-[13px] text-ink-1">{copy.INVITATIONS_EMPTY}</p>;
  return (
    <List className="flex flex-col gap-2">
      {invitations.map((invitation) => {
        const expires = Date.parse(invitation.expires_at);
        return (
          <li
            key={invitation.id}
            data-invitation={invitation.id}
            className="flex list-none flex-wrap items-center gap-2 rounded-row border border-hairline-strong bg-panel p-3"
          >
            <span className="min-w-0 flex-1 text-[13px] text-ink-1">
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
                  variant="primary"
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
