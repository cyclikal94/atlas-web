import { useId, useRef, useState } from "react";
import { useLayoutMode } from "../../../app/shell/layout-mode";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { List } from "../../../components/ui/list";
import * as base from "../copy";
import { Banner, formatWhen } from "../parts";
import * as copy from "./copy";
import { householdOf, readSignup } from "./memory";
import type { AccountInvitationSummary } from "./model";
import {
  type Ctx,
  issueSignup,
  revokeSignup,
  signupOf,
  stillLimited,
} from "./operations";
import {
  blockedReason,
  Note,
  ProblemBanner,
  UnresolvedBanner,
  useAsk,
} from "./parts";

/**
 * Q21 group 2, a household's signup invitations (`wireframes/q21/household-invitations.html`; D-12b-9), for its managers. Issue, list,
 * revoke. The token is shown ONCE, as a `#t=` fragment link (R7), held only in page memory until Done or the dialog is dismissed: never in
 * storage, the URL, history, logs, a recovery context or the announcer ("Invitation link ready to copy"). Issuing is not idempotent, so a
 * lost answer is never sent again: the list is read again and an id that is new is flagged. The cap (20 per issuer) is shown when the
 * server refuses (`limit`): the list cannot tell your own invitations from a co-manager's. After a loss of manager rights the screen is
 * read-only. Below 768 px each row is a stacked card (design-coverage §7).
 */
export function SignupDialog({
  ctx,
  householdId,
  online,
  now,
  onClose,
}: {
  ctx: Ctx;
  householdId: string;
  online: boolean;
  now: number;
  onClose(): void;
}) {
  const { memory } = ctx;
  useAsk(ctx, online, ["signup"]);
  const announcer = useAnnouncer();
  const mode = useLayoutMode();
  const heading = useId();
  const linkField = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState<"copied" | "fallback" | null>(null);
  const household = householdOf(memory, householdId);
  const manager = household?.role === "manager";
  const name = household?.name ?? "";
  const issued = memory.issued.get(householdId) ?? null;
  const list = signupOf(memory, householdId);
  const flagged = memory.flagged.get(householdId) ?? new Set<string>();
  const blocked = blockedReason(memory);
  const issueReason =
    blocked ??
    (list === null
      ? copy.SIGNUP_LIST_WAIT
      : stillLimited(memory, householdId)
        ? copy.SIGNUP_LIMIT
        : null);
  const dismiss = () => {
    // Done, Escape, the close icon: the link is forgotten (it can't be shown again).
    if (memory.issued.delete(householdId)) memory.touch();
  };
  const copyLink = async () => {
    if (issued === null) return;
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(issued.link);
      setCopied("copied");
      announcer.announce(copy.SIGNUP_COPIED);
    } catch {
      setCopied("fallback");
      linkField.current?.focus();
      linkField.current?.select();
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      onDiscard={dismiss}
      title={copy.SIGNUP_TITLE(name)}
      sheetBelow="desktop"
      footer={
        <span className="flex w-full justify-end">
          <Button
            variant="primary"
            onClick={() => {
              dismiss();
              onClose();
            }}
          >
            {copy.CLOSE_SIGNUP}
          </Button>
        </span>
      }
    >
      <div className="flex flex-col gap-5" data-signup-dialog={householdId}>
        <UnresolvedBanner ctx={ctx} />
        {household === null ? (
          <p className="text-[13.5px] text-ink-1">
            {memory.households.last !== null
              ? copy.NOT_IN_IT
              : online
                ? copy.LOADING
                : copy.OFFLINE_NEVER}
          </p>
        ) : !manager ? (
          <p className="text-[13.5px] text-ink-1" data-signup-readonly="">
            {memory.managed.has(householdId)
              ? copy.SIGNUP_ROLE_LOST
              : copy.SIGNUP_MANAGERS_ONLY}
          </p>
        ) : (
          <>
            <Note>{copy.SIGNUP_BODY(name)}</Note>
            <ProblemBanner memory={memory} surface={`signup:${householdId}`} />
            {issued !== null ? (
              <div
                className="flex flex-col gap-2 rounded-row border border-field-edge bg-panel p-3.5"
                data-signup-issued=""
              >
                <p className="text-[13.5px] font-medium text-ink-1">
                  {copy.SIGNUP_ISSUED}
                </p>
                <label className="flex flex-col gap-1 text-[12.5px] text-ink-2">
                  {copy.SIGNUP_LINK_LABEL}
                  <input
                    ref={linkField}
                    readOnly
                    value={issued.link}
                    autoComplete="off"
                    spellCheck={false}
                    onFocus={(event) => event.currentTarget.select()}
                    className="min-h-11 w-full rounded-control border border-field-edge bg-canvas px-3 font-num text-[12.5px] text-ink-1"
                  />
                </label>
                {copied === "copied" ? (
                  <p className="text-[12.5px] text-ink-2">
                    {copy.SIGNUP_COPIED}
                  </p>
                ) : copied === "fallback" ? (
                  <p className="text-[12.5px] text-ink-1">
                    {copy.SIGNUP_COPY_FALLBACK}
                  </p>
                ) : null}
                <span className="flex flex-wrap gap-2">
                  <Button variant="primary" onClick={() => void copyLink()}>
                    {copy.SIGNUP_COPY}
                  </Button>
                  <Button
                    onClick={() => {
                      dismiss();
                      setCopied(null);
                    }}
                  >
                    {copy.SIGNUP_DONE}
                  </Button>
                </span>
              </div>
            ) : (
              <span>
                {issueReason !== null ? (
                  <Button variant="primary" disabled reason={issueReason}>
                    {copy.SIGNUP_NEW}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={() =>
                      void issueSignup(ctx, householdId, window.location.origin)
                    }
                  >
                    {copy.SIGNUP_NEW}
                  </Button>
                )}
              </span>
            )}
          </>
        )}
        {household !== null ? (
          <section
            aria-labelledby={heading}
            className="flex flex-col gap-2"
            data-signup-list=""
          >
            <h3 id={heading} className="text-[13.5px] font-medium text-ink-1">
              {copy.SIGNUP_LIST_HEADING}
            </h3>
            {memory.signup.status === "failed" && list === null ? (
              <Banner
                message={copy.SIGNUP_FAILED}
                action={
                  <Button onClick={() => void readSignup(memory, ctx.api)}>
                    {base.TRY_AGAIN}
                  </Button>
                }
              />
            ) : list === null ? (
              <p className="text-[13px] text-ink-2">
                {online ? copy.SIGNUP_LOADING : copy.NEEDS_CONNECTION}
              </p>
            ) : list.length === 0 ? (
              <p className="text-[13px] text-ink-1">{copy.SIGNUP_NONE}</p>
            ) : (
              <List className="flex flex-col gap-1.5">
                {list.map((row) => (
                  <SignupRow
                    key={row.id}
                    ctx={ctx}
                    row={row}
                    householdId={householdId}
                    now={now}
                    stacked={mode === "mobile"}
                    flagged={flagged.has(row.id)}
                    revokeBlocked={manager ? blocked : null}
                    canRevoke={manager}
                  />
                ))}
              </List>
            )}
            <Note>{copy.SIGNUP_LIST_NOTE}</Note>
            {memory.signup.last !== null ? (
              <p className="text-[12px] text-ink-2">
                {base.AS_OF(formatWhen(memory.signup.last.at, now))}
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}

function SignupRow({
  ctx,
  row,
  householdId,
  now,
  stacked,
  flagged,
  canRevoke,
  revokeBlocked,
}: {
  ctx: Ctx;
  row: AccountInvitationSummary;
  householdId: string;
  now: number;
  stacked: boolean;
  flagged: boolean;
  canRevoke: boolean;
  revokeBlocked: string | null;
}) {
  const id = copy.SIGNUP_ID(row.id);
  const expires = Date.parse(row.expires_at);
  const when = Number.isNaN(expires)
    ? row.expires_at
    : formatWhen(expires, now);
  const revoke = !canRevoke ? null : revokeBlocked !== null ? (
    <Button disabled reason={revokeBlocked}>
      {copy.REVOKE}
    </Button>
  ) : (
    <Button
      aria-label={copy.SIGNUP_REVOKE(id)}
      onClick={() => void revokeSignup(ctx, row.id, householdId)}
    >
      {copy.REVOKE}
    </Button>
  );
  const cells = stacked ? (
    // Below 768 px: one stacked card, each field with its own label (design-coverage §7).
    <div className="flex flex-col gap-1" data-signup-stacked="">
      <span className="text-[13px] text-ink-1">
        {copy.SIGNUP_COL_ID}: <span className="font-num">{id}</span>
      </span>
      <span className="text-[12.5px] text-ink-2">
        {copy.SIGNUP_COL_EXPIRES}: {when}
      </span>
      <span className="text-[12.5px] text-ink-2">
        {copy.SIGNUP_COL_STATUS}: {copy.SIGNUP_ACTIVE}
      </span>
      {revoke !== null ? <span>{revoke}</span> : null}
    </div>
  ) : (
    <div
      className="grid items-center gap-3"
      style={{ gridTemplateColumns: "minmax(0,1fr) 160px 90px auto" }}
      data-signup-grid=""
    >
      <span className="font-num text-[13px] text-ink-1">{id}</span>
      <span className="text-[12.5px] text-ink-2">{when}</span>
      <span className="text-[12.5px] text-ink-2">{copy.SIGNUP_ACTIVE}</span>
      <span>{revoke}</span>
    </div>
  );
  return (
    <li
      data-signup={row.id}
      className="flex list-none flex-col gap-2 rounded-row border border-hairline-strong bg-panel px-3 py-2"
    >
      {cells}
      {flagged ? (
        <p className="text-[12.5px] text-ink-1" data-signup-flagged="">
          {copy.SIGNUP_MAYBE_NEW}
        </p>
      ) : null}
      <ProblemBanner memory={ctx.memory} surface={`signup-row:${row.id}`} />
    </li>
  );
}
