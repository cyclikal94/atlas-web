import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import * as copy from "./copy";
import { householdOf, listOf } from "./memory";
import { cmd, formContext, sameName, validName } from "./model";
import { type Ctx, run } from "./operations";
import {
  blockedReason,
  failedUnread,
  householdPath,
  Note,
  ProblemBanner,
  ReadFailed,
  UnresolvedBanner,
  useAsk,
} from "./parts";

/**
 * New household (D-12b-1, Decision H: D-12b-2). `create_household` is the one household command with no version, and a duplicate would be
 * permanent (a sole manager can never leave), so when your complete list already has a household of the same name (trimmed, case-folded)
 * it asks first. Its unresolved attempt lives in page memory: it survives in-app navigation and a remount, never a reload.
 */
export function NewHouseholdDialog({
  ctx,
  online,
  onClose,
}: {
  ctx: Ctx;
  online: boolean;
  onClose(): void;
}) {
  const { memory } = ctx;
  useAsk(ctx, online, ["households"]);
  const key = formContext.create();
  const name = memory.drafts.get(key) ?? "";
  const [asked, setAsked] = useState<string | null>(null);
  const list = listOf(memory);
  const blocked = blockedReason(memory);
  // The list it checks (the cap, the same name) failed: said with its Try again, and Create says why it waits (review 1 F-R1-1).
  const listFailed = failedUnread(memory.households, online);
  const reason =
    blocked ??
    (list === null
      ? listFailed
        ? copy.LIST_FAILED_REASON
        : copy.LIST_WAIT
      : list.length >= 32
        ? copy.AT_CAPACITY
        : !validName(name)
          ? copy.NAME_REASON
          : null);
  const duplicate = list?.find((h) => sameName(h.name, name))?.name ?? null;
  const create = () => {
    const id = ctx.newId();
    const trimmed = name.trim();
    void run(ctx, cmd.create(id, trimmed), {
      done: copy.CREATED(trimmed),
      surface: "new",
      target: id,
    }).then((result) => {
      if (result?.ok) {
        memory.draft(key, null);
        ctx.go(householdPath(id));
      }
    });
  };
  const submit = () => {
    if (reason !== null) return;
    if (duplicate !== null && asked !== name.trim()) {
      setAsked(name.trim());
      return;
    }
    setAsked(null);
    create();
  };
  const confirming = duplicate !== null && asked === name.trim();
  return (
    <Dialog
      open
      onClose={onClose}
      title={copy.NEW_TITLE}
      sheetBelow="desktop"
      footer={
        <span className="flex w-full flex-wrap justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            {copy.CANCEL_ACTION}
          </Button>
          {reason !== null ? (
            <Button variant="primary" disabled reason={reason}>
              {confirming ? copy.CREATE_ANOTHER : copy.CREATE}
            </Button>
          ) : (
            <Button variant="primary" type="submit" form="households-new">
              {confirming ? copy.CREATE_ANOTHER : copy.CREATE}
            </Button>
          )}
        </span>
      }
    >
      <form
        id="households-new"
        className="flex flex-col gap-3"
        data-households-new=""
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <UnresolvedBanner ctx={ctx} />
        <ProblemBanner memory={memory} surface="new" />
        {listFailed ? (
          <ReadFailed ctx={ctx} kind="households" message={copy.FAILED} />
        ) : null}
        <Input
          label={copy.NAME_LABEL}
          surface="panel"
          value={name}
          maxLength={300}
          onChange={(event) => {
            memory.draft(key, event.target.value);
          }}
        />
        {confirming && duplicate !== null ? (
          <p className="text-[13px] text-ink-1" data-households-same-name="">
            {copy.SAME_NAME(duplicate)}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Rename (managers; the household's version). */
export function RenameDialog({
  ctx,
  householdId,
  online,
  onClose,
}: {
  ctx: Ctx;
  householdId: string;
  online: boolean;
  onClose(): void;
}) {
  const { memory } = ctx;
  useAsk(ctx, online, ["households"]);
  const household = householdOf(memory, householdId);
  const key = formContext.rename(householdId);
  const name = memory.drafts.get(key) ?? household?.name ?? "";
  const blocked = blockedReason(memory);
  const manager = household?.role === "manager";
  const reason =
    blocked ??
    (!validName(name)
      ? copy.NAME_REASON
      : household !== null && name.trim() === household.name
        ? copy.SAME_AS_NOW
        : null);
  return (
    <Dialog
      open
      onClose={onClose}
      onDiscard={() => memory.draft(key, null)}
      title={copy.RENAME_TITLE(household?.name ?? "")}
      sheetBelow="desktop"
      footer={
        manager ? (
          <span className="flex w-full flex-wrap justify-end gap-2">
            <Button variant="quiet" onClick={onClose}>
              {copy.CANCEL_ACTION}
            </Button>
            {reason !== null ? (
              <Button variant="primary" disabled reason={reason}>
                {copy.SAVE_NAME}
              </Button>
            ) : (
              <Button variant="primary" type="submit" form="households-rename">
                {copy.SAVE_NAME}
              </Button>
            )}
          </span>
        ) : undefined
      }
    >
      <form
        id="households-rename"
        className="flex flex-col gap-3"
        data-households-rename={householdId}
        onSubmit={(event) => {
          event.preventDefault();
          if (reason !== null || household === null || !manager) return;
          const trimmed = name.trim();
          void run(ctx, cmd.rename(household, trimmed), {
            done: copy.RENAMED(trimmed),
            surface: `rename:${householdId}`,
            target: householdId,
          }).then((result) => {
            if (result?.ok) {
              memory.draft(key, null);
              onClose();
            }
          });
        }}
      >
        <UnresolvedBanner
          ctx={ctx}
          // A lost rename that Try again (pressed here) found made closes the dialog, as its first try would have (review 1 F-R1-2).
          onRetried={(completed) => {
            if (completed.surface === `rename:${householdId}`) onClose();
          }}
        />
        <ProblemBanner memory={memory} surface={`rename:${householdId}`} />
        {household === null && failedUnread(memory.households, online) ? (
          <ReadFailed ctx={ctx} kind="households" message={copy.FAILED} />
        ) : household === null ? (
          <p className="text-[13.5px] text-ink-1">
            {memory.households.last !== null
              ? copy.NOT_IN_IT
              : online
                ? copy.LOADING
                : copy.OFFLINE_NEVER}
          </p>
        ) : !manager ? (
          <Note>
            {memory.managed.has(householdId)
              ? copy.LOST_MANAGER
              : copy.INVITE_MANAGERS_ONLY}
          </Note>
        ) : (
          <Input
            label={copy.NAME_LABEL}
            surface="panel"
            value={name}
            maxLength={300}
            onChange={(event) => memory.draft(key, event.target.value)}
          />
        )}
      </form>
    </Dialog>
  );
}
