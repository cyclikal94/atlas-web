import { useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { RecoveryNotice } from "../../../lib/form-recovery/RecoveryNotice";
import * as copy from "./copy";
import {
  completeTicket,
  createRecovery,
  type RenameInput,
  renameRecovery,
  useHouseholdRecovery,
} from "./form-recovery";
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
 *
 * M-1 (WEB-12b merge of 2f42ac35; WEB-14a's Q4, `form-recovery.ts`): the name is recoverable around an app update (`household-create`, the
 * context WEB-14a gave the inline create form this dialog replaced): registered while shown and while a kept draft is dirty, frozen while
 * an update reload is prepared, restored into an untouched dialog after the update's reload, never submitted.
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
  const nameRef = useRef<HTMLInputElement>(null);
  const recovery = useHouseholdRecovery({
    memory,
    key,
    shown: true,
    codec: createRecovery(),
    start: () => "",
    value: () => memory.drafts.get(key) ?? "",
    restored: (value) => memory.recovered(key, value),
    reset: () => memory.recovered(key, null),
  });
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
    // M-1: the ticket first, in the same step as the name it sends (none while an update reload is prepared: nothing is sent).
    const ticket = recovery.submitting();
    if (ticket === null) return;
    void run(ctx, cmd.create(id, trimmed), {
      done: copy.CREATED(trimmed),
      surface: "new",
      target: id,
    }).then((result) => {
      // I7 (WEB-14a revision 38): the draft is cleared only while it is still what this create sent; a name typed meanwhile stays.
      const unchanged = ticket.current();
      completeTicket(ticket, result?.ok === true);
      if (result?.ok) {
        if (unchanged) memory.draft(key, null);
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
          <Button variant="ghost" onClick={onClose}>
            {copy.CANCEL_ACTION}
          </Button>
          {reason !== null ? (
            <Button variant="default" disabled reason={reason}>
              {confirming ? copy.CREATE_ANOTHER : copy.CREATE}
            </Button>
          ) : (
            <Button variant="default" type="submit" form="households-new">
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
        <RecoveryNotice recovery={recovery} firstFieldRef={nameRef} />
        <Input
          ref={nameRef}
          label={copy.NAME_LABEL}
          value={name}
          maxLength={300}
          onChange={(event) => {
            // M-1: the model takes the change first; while an update reload is prepared it refuses, and the field keeps what it shows.
            if (recovery.edit(event.target.value))
              memory.draft(key, event.target.value);
          }}
        />
        {confirming && duplicate !== null ? (
          <p className="text-sm text-foreground" data-households-same-name="">
            {copy.SAME_NAME(duplicate)}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * Rename (managers; the household's version). M-1: the typed name is recoverable (`household-rename:<id>`) with the household version it
 * was composed against: a restored rename is saved under THAT version, so a household renamed meanwhile meets the server's conflict
 * ("changed elsewhere") and is read again, never overwritten; after that refusal the next Save is against the version read now.
 */
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
  const nameRef = useRef<HTMLInputElement>(null);
  const recovery = useHouseholdRecovery<RenameInput>({
    memory,
    key,
    // Bound (and so looking) only once the household is read and its name field shown.
    shown: household !== null && manager,
    codec: renameRecovery(householdId),
    start: () => ({
      text: household?.name ?? "",
      base: household?.version ?? null,
    }),
    value: () => ({
      text: memory.drafts.get(key) ?? household?.name ?? "",
      base: memory.bases.get(key) ?? household?.version ?? null,
    }),
    restored: (value) => memory.recovered(key, value.text, value.base),
    reset: () => memory.recovered(key, null),
  });
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
            <Button variant="ghost" onClick={onClose}>
              {copy.CANCEL_ACTION}
            </Button>
            {reason !== null ? (
              <Button variant="default" disabled reason={reason}>
                {copy.SAVE_NAME}
              </Button>
            ) : (
              <Button variant="default" type="submit" form="households-rename">
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
          // M-1: a restored rename is guarded by the version it was composed against.
          const base = memory.bases.get(key);
          const target =
            base === undefined ? household : { ...household, version: base };
          const ticket = recovery.submitting();
          if (ticket === null) return;
          void run(ctx, cmd.rename(target, trimmed), {
            done: copy.RENAMED(trimmed),
            surface: `rename:${householdId}`,
            target: householdId,
          }).then((result) => {
            const unchanged = ticket.current();
            completeTicket(ticket, result?.ok === true);
            if (result?.ok) {
              if (unchanged) memory.draft(key, null);
              onClose();
            } else if (result !== null && result.kind === "conflict")
              // Said ("changed elsewhere") and read again: the next Save is against the version read now.
              memory.bases.delete(key);
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
          <p className="text-sm text-foreground">
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
          <>
            <RecoveryNotice recovery={recovery} firstFieldRef={nameRef} />
            <Input
              ref={nameRef}
              label={copy.NAME_LABEL}
              value={name}
              maxLength={300}
              onChange={(event) => {
                if (
                  recovery.edit({
                    text: event.target.value,
                    base: memory.bases.get(key) ?? household.version,
                  })
                )
                  memory.draft(key, event.target.value);
              }}
            />
          </>
        )}
      </form>
    </Dialog>
  );
}
