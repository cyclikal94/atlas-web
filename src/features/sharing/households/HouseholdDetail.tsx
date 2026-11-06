import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { List } from "../../../components/ui/list";
import type { DefaultsRecord, SnapshotHousehold } from "../../../data";
import { formatWhen } from "../parts";
import * as copy from "./copy";
import { householdOf } from "./memory";
import {
  cmd,
  daysLeft,
  lastManager,
  type SentInvitation,
  soleMember,
} from "./model";
import { type Ctx, run } from "./operations";
import {
  blockedReason,
  invitationsPath,
  Note,
  ProblemBanner,
  renamePath,
  signupPath,
  useAsk,
} from "./parts";

type Confirm =
  | { kind: "leave" }
  | { kind: "remove"; accountId: string; who: string }
  | { kind: "demote"; accountId: string; who: string; self: boolean }
  | { kind: "stop-main" };

const LINK =
  "atlas-transition inline-flex min-h-11 items-center rounded-control border border-hairline-strong bg-raised px-4 text-[13.5px] text-ink-1 hover:bg-row-hover";

/**
 * One household (WF-SHARING-01's detail). Members and roles from the complete list (`GET /households`; no join date in the contract), the
 * main household from the B5 record only (never inferred from the list: D-12b-8), the manager's actions (members see none, with a
 * one-line note: SHARE-6a), and the last-manager and sole-member rules shown with their reason and fix (SHARE-6). The server stays the
 * authority: a stale view's refusal is shown with its request id, and the list is read again.
 */
export function HouseholdDetail({
  ctx,
  householdId,
  online,
  now,
  record,
}: {
  ctx: Ctx;
  householdId: string;
  online: boolean;
  now: number;
  record: DefaultsRecord | null;
}) {
  const { memory } = ctx;
  // Opening a household reads its members again (a change made elsewhere shows), once per mount: a remount adds one read, never a loop.
  useAsk(ctx, online, ["households", "sent"]);
  const heading = useId();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const read = memory.households;
  const household = householdOf(memory, householdId);
  const surface = `detail:${householdId}`;
  if (household === null) {
    // Offline before the list was read: the B5 snapshot may name it (read-only, with its time); otherwise nothing is known.
    const fromSnapshot =
      read.last === null
        ? (record?.snapshot.households.find((h) => h.id === householdId) ??
          null)
        : null;
    if (fromSnapshot === null)
      return (
        <section className="flex flex-col gap-3" data-household-detail="absent">
          <ProblemBanner memory={memory} surface={surface} />
          <p className="text-[13.5px] text-ink-1">
            {read.last !== null
              ? copy.NOT_IN_IT
              : online
                ? copy.LOADING
                : copy.OFFLINE_NEVER}
          </p>
          {read.last !== null ? (
            <Link to="/sharing" className={LINK}>
              {copy.NOT_IN_IT_LINK}
            </Link>
          ) : null}
        </section>
      );
  }
  const shown =
    household ??
    (record?.snapshot.households.find(
      (h) => h.id === householdId,
    ) as SnapshotHousehold);
  const complete = household !== null;
  const primaryId = record?.snapshot.defaults.primary_household_id;
  const isPrimary = record !== null && primaryId === householdId;
  const manager = complete && shown.role === "manager";
  const blocked = blockedReason(memory);
  const me = ctx.accountId;
  const onlyManager = lastManager(shown, me);
  const alone = soleMember(shown);
  const leaveReason = alone
    ? copy.SOLE_MEMBER(shown.name)
    : onlyManager
      ? copy.LAST_MANAGER(shown.name)
      : null;
  const waiting: SentInvitation[] =
    memory.sent.last?.value.items.filter(
      (s) => s.household_id === householdId && s.status === "pending",
    ) ?? [];

  const send = (
    command: Parameters<typeof run>[1],
    done: string,
    then?: () => void,
  ) =>
    void run(ctx, command, { done, surface, target: householdId }).then(
      (result) => {
        if (result?.ok) then?.();
        // The main household is the B5 record's (D-12b-8): a stale preferences_version means it changed elsewhere; read it again.
        if (
          result !== null &&
          !result.ok &&
          result.kind === "conflict" &&
          command.kind === "set_primary_household"
        ) {
          memory.note(surface, {
            message: copy.MAIN_CHANGED,
            ...("requestId" in result && result.requestId
              ? { requestId: result.requestId }
              : {}),
          });
          void ctx.defaults.acquire(ctx.defaults.boundary());
        }
      },
    );
  const confirmed = () => {
    const c = confirm;
    setConfirm(null);
    if (c === null) return;
    if (c.kind === "leave")
      send(cmd.remove(shown, me), copy.LEFT(shown.name), () =>
        ctx.go("/sharing"),
      );
    else if (c.kind === "remove")
      send(cmd.remove(shown, c.accountId), copy.REMOVED(c.who));
    else if (c.kind === "demote")
      send(cmd.setRole(shown, c.accountId, false), copy.DEMOTED(c.who));
    else if (record !== null)
      send(
        cmd.setPrimary(null, record.snapshot.defaults.preferences_version),
        copy.MAIN_CLEARED,
      );
  };
  const action = (
    label: string,
    reason: string | null,
    onClick: () => void,
    name?: string,
  ) =>
    reason !== null ? (
      <Button
        disabled
        reason={reason}
        {...(name ? { "aria-label": name } : {})}
      >
        {label}
      </Button>
    ) : (
      <Button onClick={onClick} {...(name ? { "aria-label": name } : {})}>
        {label}
      </Button>
    );
  const mainReason = blocked ?? (record === null ? copy.MAIN_WAIT : null);

  return (
    <section
      aria-labelledby={heading}
      className="flex min-w-0 flex-col gap-5"
      data-household-detail={householdId}
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2
            id={heading}
            className="min-w-0 break-words text-[17px] font-medium text-ink-1"
          >
            {shown.name}
          </h2>
          {isPrimary ? (
            <span className="rounded-badge border border-hairline-strong px-1.5 py-0.5 text-[11.5px] text-ink-2">
              {copy.MAIN_BADGE}
            </span>
          ) : null}
        </div>
        <p className="text-[13px] text-ink-2" data-household-main="">
          {isPrimary ? copy.MAIN_NOTE(shown.name) : copy.NOT_MAIN_NOTE}
        </p>
        {complete ? (
          <div className="flex flex-wrap gap-2">
            {manager ? (
              <>
                <Link to={renamePath(householdId) as never} className={LINK}>
                  {copy.RENAME}
                </Link>
                <Link
                  to={invitationsPath(householdId) as never}
                  className={LINK}
                >
                  {copy.INVITE_PEOPLE}
                </Link>
                <Link to={signupPath(householdId) as never} className={LINK}>
                  {copy.SIGNUP_ENTRY}
                </Link>
              </>
            ) : null}
            {isPrimary ? (
              <Link
                to="/sharing/defaults"
                search={{ kind: "person" }}
                className={LINK}
              >
                {copy.EDIT_DEFAULTS}
              </Link>
            ) : null}
            {isPrimary
              ? action(copy.STOP_MAIN, mainReason, () =>
                  setConfirm({ kind: "stop-main" }),
                )
              : action(copy.MAKE_MAIN, mainReason, () => {
                  if (record !== null)
                    send(
                      cmd.setPrimary(
                        householdId,
                        record.snapshot.defaults.preferences_version,
                      ),
                      copy.MAIN_SET(shown.name),
                    );
                })}
          </div>
        ) : null}
      </div>
      <ProblemBanner memory={memory} surface={surface} />
      {complete && !manager ? (
        <Note>
          {memory.managed.has(householdId)
            ? copy.LOST_MANAGER
            : copy.MEMBERS_CANT_MANAGE}
        </Note>
      ) : null}
      <section className="flex flex-col gap-2" data-household-members="">
        <h3 className="text-[13.5px] font-medium text-ink-1">
          {copy.MEMBERS_HEADING}
        </h3>
        {read.last !== null ? (
          <p className="text-[12px] text-ink-2">
            {copy.MEMBERS_AS_OF(formatWhen(read.last.at, now))}
          </p>
        ) : null}
        <List className="flex flex-col gap-1.5">
          {shown.members.map((member) => {
            const self = member.account_id === me;
            const who = member.username;
            return (
              <li
                key={member.account_id}
                data-member={member.account_id}
                className="flex min-h-11 list-none flex-wrap items-center gap-x-3 gap-y-2 rounded-row border border-hairline-strong bg-panel px-3.5 py-2"
              >
                <span className="min-w-0 flex-1 break-words text-[13.5px] text-ink-1">
                  {who}
                  {self ? ` (${copy.YOU})` : ""}
                </span>
                <span className="text-[12.5px] text-ink-2" data-member-role="">
                  {copy.ROLE[member.role]}
                </span>
                {!complete ? null : self ? (
                  <span className="flex flex-wrap gap-2">
                    {manager
                      ? action(
                          copy.DEMOTE,
                          onlyManager ? copy.LAST_MANAGER_DEMOTE : blocked,
                          () =>
                            setConfirm({
                              kind: "demote",
                              accountId: me,
                              who,
                              self: true,
                            }),
                          `${copy.DEMOTE}: ${who}`,
                        )
                      : null}
                    {action(
                      copy.LEAVE,
                      leaveReason ?? blocked,
                      () => setConfirm({ kind: "leave" }),
                      `${copy.LEAVE}: ${shown.name}`,
                    )}
                  </span>
                ) : manager ? (
                  <span className="flex flex-wrap gap-2">
                    {member.role === "member"
                      ? action(
                          copy.PROMOTE,
                          blocked,
                          () =>
                            send(
                              cmd.setRole(shown, member.account_id, true),
                              copy.PROMOTED(who),
                            ),
                          `${copy.PROMOTE}: ${who}`,
                        )
                      : action(
                          copy.DEMOTE,
                          blocked,
                          () =>
                            setConfirm({
                              kind: "demote",
                              accountId: member.account_id,
                              who,
                              self: false,
                            }),
                          `${copy.DEMOTE}: ${who}`,
                        )}
                    {action(
                      copy.REMOVE,
                      blocked,
                      () =>
                        setConfirm({
                          kind: "remove",
                          accountId: member.account_id,
                          who,
                        }),
                      `${copy.REMOVE}: ${who}`,
                    )}
                  </span>
                ) : null}
              </li>
            );
          })}
        </List>
      </section>
      {complete ? (
        <section className="flex flex-col gap-2" data-household-waiting="">
          <h3 className="text-[13.5px] font-medium text-ink-1">
            {copy.WAITING_HEADING}
          </h3>
          {memory.sent.last === null ? (
            <p className="text-[12.5px] text-ink-2">
              {online ? copy.SENT_LOADING : copy.NEEDS_CONNECTION}
            </p>
          ) : waiting.length === 0 ? (
            <p className="text-[12.5px] text-ink-2">{copy.WAITING_NONE}</p>
          ) : (
            <List className="flex flex-col gap-1">
              {waiting.map((s) => (
                <li
                  key={s.id}
                  data-waiting={s.id}
                  className="list-none text-[13px] text-ink-1"
                >
                  {s.recipient_username} ·{" "}
                  {copy.STATUS.pending(daysLeft(s.expires_at, now))}
                </li>
              ))}
            </List>
          )}
          {memory.sent.last !== null ? (
            <p className="text-[12px] text-ink-2">
              {copy.MEMBERS_AS_OF(formatWhen(memory.sent.last.at, now))}
            </p>
          ) : null}
        </section>
      ) : null}
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={
          confirm?.kind === "leave"
            ? copy.LEAVE
            : confirm?.kind === "remove"
              ? copy.REMOVE
              : confirm?.kind === "demote"
                ? copy.DEMOTE
                : copy.STOP_MAIN
        }
        syncControl={false}
        sheetBelow="desktop"
        footer={
          <span className="flex w-full flex-wrap justify-end gap-2">
            <Button variant="quiet" onClick={() => setConfirm(null)}>
              {copy.CANCEL_ACTION}
            </Button>
            {blocked !== null ? (
              <Button variant="primary" disabled reason={blocked}>
                {copy.CONFIRM}
              </Button>
            ) : (
              <Button variant="primary" onClick={confirmed}>
                {copy.CONFIRM}
              </Button>
            )}
          </span>
        }
      >
        <p className="text-[13.5px] leading-[1.55] text-ink-1">
          {confirm?.kind === "leave"
            ? copy.LEAVE_CONFIRM(shown.name, isPrimary)
            : confirm?.kind === "remove"
              ? copy.REMOVE_CONFIRM(confirm.who, shown.name)
              : confirm?.kind === "demote"
                ? confirm.self
                  ? copy.DEMOTE_SELF_CONFIRM(shown.name)
                  : copy.DEMOTE_CONFIRM(confirm.who)
                : copy.STOP_MAIN_CONFIRM(shown.name)}
        </p>
      </Dialog>
    </section>
  );
}
