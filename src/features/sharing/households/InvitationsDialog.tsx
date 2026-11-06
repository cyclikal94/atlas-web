import { useId } from "react";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { List } from "../../../components/ui/list";
import type { Invitation } from "../api";
import * as base from "../copy";
import { DirectoryLookup } from "../DirectoryLookup";
import { Banner, formatWhen } from "../parts";
import * as copy from "./copy";
import { householdOf, listOf, readInvitations, walkSent } from "./memory";
import {
  daysLeft,
  formContext,
  groupByHousehold,
  type SentInvitation,
} from "./model";
import {
  type Ctx,
  invite,
  membershipCount,
  respond,
  revokeSent,
} from "./operations";
import {
  blockedReason,
  Note,
  ProblemBanner,
  UnresolvedBanner,
  useAsk,
} from "./parts";

/**
 * WF-SHARING-02 (D-12b-1, D-12b-4, D-12b-13, D-12b-14): a route-addressed dialog, so a `403` remount reopens it with its state from page
 * memory. Opened from the page header (`householdId` null: works with zero households) it lists the invitations for you and everything
 * you sent, grouped by household (households you have left too: a non-operational invitation stays visible with its own status). Opened
 * for a household it adds, for its managers, "Invite someone to ‹Home›", and lists what you sent for that household.
 *
 * "Sent by you" is `GET /invitations/sent`, which is SENDER-keyed: invitations other managers sent are not in it, and the dialog says so.
 * Every status is the server's, verbatim; Revoke is offered only on a waiting row of a household you manage (its own version).
 */
export function InvitationsDialog({
  ctx,
  householdId,
  online,
  now,
  onClose,
}: {
  ctx: Ctx;
  householdId: string | null;
  online: boolean;
  now: number;
  onClose(): void;
}) {
  const { memory } = ctx;
  useAsk(ctx, online, ["invitations", "sent"]);
  const ids = { forYou: useId(), invite: useId(), sent: useId() };
  const household =
    householdId === null ? null : householdOf(memory, householdId);
  const scope = householdId ?? "all";
  const lookupKey = `households:lookup:${scope}`;
  const lookupOpen = memory.drafts.get(lookupKey) === "open";
  const draftKey =
    householdId === null ? null : formContext.invite(householdId);
  const username = draftKey === null ? "" : (memory.drafts.get(draftKey) ?? "");
  const blocked = blockedReason(memory);
  const title =
    household === null
      ? copy.INVITATIONS_TITLE
      : copy.INVITATIONS_TITLE_FOR(household.name);
  const manager = household?.role === "manager";
  const managedIds = new Set(
    (listOf(memory) ?? []).filter((h) => h.role === "manager").map((h) => h.id),
  );
  const atCapacity = (membershipCount(memory) ?? 0) >= 32;

  const lookup =
    lookupOpen && household !== null && manager ? (
      <DirectoryLookup
        purpose={copy.INVITE_HEADING(household.name)}
        onChoose={(entry) => {
          if (draftKey !== null) memory.draft(draftKey, entry.username);
          memory.draft(lookupKey, null);
        }}
        onBack={() => memory.draft(lookupKey, null)}
        browse={{
          read: () => ctx.api.browse(),
          refused: memory.browseRefused,
          onRefused: () => {
            memory.browseRefused = true;
            memory.touch();
          },
        }}
        keep={{
          get: (which) =>
            memory.drafts.get(`households:lookup-${which}:${scope}`) ?? "",
          set: (which, value) => {
            memory.drafts.set(`households:lookup-${which}:${scope}`, value);
          },
        }}
      />
    ) : null;

  const sent: SentInvitation[] =
    memory.sent.last?.value.items.filter(
      (s) => householdId === null || s.household_id === householdId,
    ) ?? [];
  const pending = (memory.invitations.last?.value ?? []).filter(
    (i) => i.status === "pending",
  );
  // A stale answer of a row the list no longer has (it expired or was answered): said at the section's top, with its household.
  const orphaned = [...memory.problems.entries()].filter(
    ([surface]) =>
      surface.startsWith("respond:") &&
      !pending.some((i) => `respond:${i.id}` === surface),
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      sheetBelow="desktop"
      onDiscard={() => memory.draft(lookupKey, null)}
      footer={
        lookup !== null ? undefined : (
          <span className="flex w-full justify-end">
            <Button variant="primary" onClick={onClose}>
              {copy.CLOSE}
            </Button>
          </span>
        )
      }
    >
      {lookup ?? (
        <div className="flex flex-col gap-6" data-invitations-dialog={scope}>
          <UnresolvedBanner ctx={ctx} />
          <section
            aria-labelledby={ids.forYou}
            className="flex flex-col gap-2"
            data-invitations="for-you"
          >
            <h3
              id={ids.forYou}
              className="text-[13.5px] font-medium text-ink-1"
            >
              {copy.FOR_YOU}
            </h3>
            {orphaned.map(([surface, problem]) => (
              <Banner
                key={surface}
                message={problem.message}
                requestId={problem.requestId}
              />
            ))}
            {memory.invitations.status === "failed" &&
            memory.invitations.last === null ? (
              <Banner
                message={copy.FAILED}
                action={
                  <Button onClick={() => void readInvitations(memory, ctx.api)}>
                    {base.TRY_AGAIN}
                  </Button>
                }
              />
            ) : memory.invitations.last === null ? (
              <p className="text-[13px] text-ink-2">
                {online ? copy.LOADING : copy.NEEDS_CONNECTION}
              </p>
            ) : pending.length === 0 ? (
              <p className="text-[13px] text-ink-1">{copy.FOR_YOU_NONE}</p>
            ) : (
              <List className="flex flex-col gap-2">
                {pending.map((invitation) => (
                  <ForYouRow
                    key={invitation.id}
                    ctx={ctx}
                    invitation={invitation}
                    now={now}
                    blocked={blocked ?? null}
                    acceptBlocked={
                      blocked ?? (atCapacity ? copy.AT_CAPACITY : null)
                    }
                  />
                ))}
              </List>
            )}
          </section>
          {household !== null ? (
            <section
              aria-labelledby={ids.invite}
              className="flex flex-col gap-2"
              data-invitations="invite"
            >
              <h3
                id={ids.invite}
                className="text-[13.5px] font-medium text-ink-1"
              >
                {copy.INVITE_HEADING(household.name)}
              </h3>
              {manager && draftKey !== null ? (
                <>
                  <ProblemBanner
                    memory={memory}
                    surface={`invite:${household.id}`}
                  />
                  <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const name = username.trim();
                      if (blocked !== null || name === "") return;
                      void invite(
                        ctx,
                        household,
                        name,
                        `invite:${household.id}`,
                      ).then((ok) => {
                        if (ok) memory.draft(draftKey, null);
                      });
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <Input
                        label={copy.USERNAME_LABEL}
                        surface="panel"
                        value={username}
                        autoCapitalize="none"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) =>
                          memory.draft(draftKey, event.target.value)
                        }
                      />
                    </div>
                    {blocked !== null ? (
                      <Button disabled reason={blocked}>
                        {copy.INVITE}
                      </Button>
                    ) : username.trim() === "" ? (
                      <Button disabled reason={copy.INVITE_REASON}>
                        {copy.INVITE}
                      </Button>
                    ) : (
                      <Button variant="primary" type="submit">
                        {copy.INVITE}
                      </Button>
                    )}
                  </form>
                  {online ? (
                    <span>
                      <Button
                        variant="quiet"
                        onClick={() => memory.draft(lookupKey, "open")}
                      >
                        {copy.FIND_ACCOUNT}
                      </Button>
                    </span>
                  ) : null}
                  <Note>{copy.INVITE_RULE}</Note>
                </>
              ) : (
                <Note>
                  {memory.managed.has(household.id)
                    ? copy.LOST_MANAGER
                    : copy.INVITE_MANAGERS_ONLY}
                </Note>
              )}
            </section>
          ) : null}
          <section
            aria-labelledby={ids.sent}
            className="flex flex-col gap-2"
            data-invitations="sent"
          >
            <h3 id={ids.sent} className="text-[13.5px] font-medium text-ink-1">
              {copy.SENT_HEADING}
            </h3>
            <Note>{copy.SENT_NOTE}</Note>
            <ProblemBanner memory={memory} surface={`sent:${scope}`} />
            {memory.sent.status === "failed" && memory.sent.last === null ? (
              <Banner
                message={copy.SENT_FAILED}
                action={
                  <Button onClick={() => void walkSent(memory, ctx.api)}>
                    {base.TRY_AGAIN}
                  </Button>
                }
              />
            ) : memory.sent.last === null ? (
              <p className="text-[13px] text-ink-2">
                {online ? copy.SENT_LOADING : copy.NEEDS_CONNECTION}
              </p>
            ) : sent.length === 0 ? (
              <p className="text-[13px] text-ink-1">{copy.SENT_NONE}</p>
            ) : householdId !== null ? (
              <SentList
                ctx={ctx}
                items={sent}
                now={now}
                canRevoke={managedIds.has(householdId)}
                blocked={blocked}
                surface={`sent:${scope}`}
              />
            ) : (
              groupByHousehold(sent).map((group) => (
                <div
                  key={group.householdId}
                  className="flex flex-col gap-1.5"
                  data-sent-group={group.householdId}
                >
                  <h4 className="text-[13px] font-medium text-ink-1">
                    {group.name}
                  </h4>
                  <SentList
                    ctx={ctx}
                    items={group.items}
                    now={now}
                    canRevoke={managedIds.has(group.householdId)}
                    blocked={blocked}
                    surface={`sent:${scope}`}
                  />
                </div>
              ))
            )}
            {memory.sent.last?.value.truncated ? (
              <Note>{copy.SENT_TRUNCATED}</Note>
            ) : null}
            {memory.sent.last !== null ? (
              <p className="text-[12px] text-ink-2">
                {base.AS_OF(formatWhen(memory.sent.last.at, now))}
              </p>
            ) : null}
          </section>
        </div>
      )}
    </Dialog>
  );
}

function ForYouRow({
  ctx,
  invitation,
  now,
  blocked,
  acceptBlocked,
}: {
  ctx: Ctx;
  invitation: Invitation;
  now: number;
  blocked: string | null;
  acceptBlocked: string | null;
}) {
  const name = invitation.household_name;
  return (
    <li
      data-invitation={invitation.id}
      className="flex list-none flex-col gap-2 rounded-row border border-hairline-strong bg-panel p-3"
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 break-words text-[13px] text-ink-1">
          {copy.INVITED_YOU(name, daysLeft(invitation.expires_at, now))}
        </span>
        {blocked !== null ? (
          <Button disabled reason={blocked}>
            {copy.DECLINE}
          </Button>
        ) : (
          <Button
            aria-label={`${copy.DECLINE}: ${name}`}
            onClick={() => void respond(ctx, invitation, false)}
          >
            {copy.DECLINE}
          </Button>
        )}
        {acceptBlocked !== null ? (
          <Button variant="primary" disabled reason={acceptBlocked}>
            {copy.ACCEPT}
          </Button>
        ) : (
          <Button
            variant="primary"
            aria-label={`${copy.ACCEPT}: ${name}`}
            onClick={() => void respond(ctx, invitation, true)}
          >
            {copy.ACCEPT}
          </Button>
        )}
      </span>
      <ProblemBanner memory={ctx.memory} surface={`respond:${invitation.id}`} />
    </li>
  );
}

function SentList({
  ctx,
  items,
  now,
  canRevoke,
  blocked,
  surface,
}: {
  ctx: Ctx;
  items: SentInvitation[];
  now: number;
  canRevoke: boolean;
  blocked: string | null;
  surface: string;
}) {
  return (
    <List className="flex flex-col gap-1.5">
      {items.map((s) => (
        <li
          key={s.id}
          data-sent={s.id}
          data-sent-status={s.status}
          className="flex min-h-11 list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-row border border-hairline-strong bg-panel px-3 py-1.5"
        >
          <span className="min-w-0 flex-1 break-words text-[13.5px] text-ink-1">
            {s.recipient_username}
          </span>
          <span className="text-[12.5px] text-ink-2">
            {s.status === "pending"
              ? copy.STATUS.pending(daysLeft(s.expires_at, now))
              : copy.STATUS[s.status]}
          </span>
          {s.status === "pending" && canRevoke ? (
            blocked !== null ? (
              <Button disabled reason={blocked}>
                {copy.REVOKE}
              </Button>
            ) : (
              <Button
                aria-label={`${copy.REVOKE}: ${s.recipient_username}`}
                onClick={() => void revokeSent(ctx, s, surface)}
              >
                {copy.REVOKE}
              </Button>
            )
          ) : null}
        </li>
      ))}
    </List>
  );
}
