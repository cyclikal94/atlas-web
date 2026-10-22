import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { PageHeading } from "../../../components/ui/page-heading";
import type { DraftWithCommand } from "../../../data";
import { ResourcePolicyEditor } from "../../sharing";
import type { PeopleFailure } from "../api";
import * as copy from "../copy";
import { usePeopleEnv } from "../env";
import { isCurrentMemory, useMemoryRevision } from "../memory";
import {
  archiveRequest,
  baseGuard,
  renameEditRequest,
  renameProfileBody,
  unlinkBody,
} from "../model/commands";
import { firstPageCount } from "../model/duplicates";
import { type LinkageState, renameRoute, unlinkOffer } from "../model/linkage";
import type { ShownRow } from "../model/project";
import {
  type EditSnapshot,
  reviewedDraft,
  snapshotOf,
  stillBound,
  successorFollows,
} from "../model/snapshot";
import { charCount } from "../model/values";
import { sendOnline } from "../online";
import { Avatar, Banner, PendingBadge, useOutboxSave } from "../parts";
import { readLinkage, usePersonLinkage } from "../reads";

/**
 * The identity header of WF-PEOPLE-02 with the Q21 gap-6 additions (`profile-rename-unlink.html`) and the archive entry point
 * (`archive-restore.html`): the linkage line (only what a `GET /people/{id}` answer says, D-11a-2), Manage sharing (WEB-12a's editor on
 * the person), Possible duplicates, Rename (D-11a-5), Unlink account (D-11a-6) and Archive / Restore (D-11a-10). `headerActions` is the
 * slot WEB-11b fills ("Ask to link…"); WEB-11a renders nothing in it.
 *
 * Its state (an open rename form or unlink dialog, the sharing editor) belongs to ONE person: the person's screen is keyed by the person's
 * id (`screens.tsx`), so a
 * change of the route's person never carries a form, a typed name or a dialog over to another person (finding 4 of the review of 13
 * October). A typed rename is kept under its own person (`rename:<id>` in page memory) and comes back only on that person.
 */
export function IdentityHeader({
  shown,
  asPage,
  headerActions,
  drafts,
}: {
  shown: ShownRow;
  /** The person's name is the page's heading (no list beside it). */
  asPage: boolean;
  headerActions?: (personId: string) => ReactNode;
  /** This device's outstanding saves (the rename's base, `model/snapshot.ts`). */
  drafts: readonly DraftWithCommand[];
}) {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const person = shown.row;
  const { linkage, retry } = usePersonLinkage(person.id);
  const [renaming, setRenaming] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [sharing, setSharing] = useState(false);
  const Heading = asPage ? PageHeading : SubHeading;
  const renamingFrom = env.memory.drafts.get(`renaming:${person.id}`) as
    | number
    | undefined;
  const updating =
    renamingFrom !== undefined &&
    !shown.projected &&
    person.version <= renamingFrom;
  return (
    <section className="flex flex-col gap-4" data-identity-header="">
      <div className="flex items-start gap-4">
        <Avatar name={person.label} size="large" />
        <div className="flex min-w-0 flex-col gap-1">
          <Heading>
            <span data-person-name="">{person.label}</span>
          </Heading>
          <LinkageLine
            linkage={linkage}
            name={person.label}
            onRetry={retry}
            online={env.online}
          />
          <div className="flex flex-wrap items-center gap-2">
            {person.archived ? (
              <span className="text-[12.5px] text-ink-2">
                {copy.ARCHIVED_TAG}
              </span>
            ) : null}
            <PendingBadge mark={shown.pending} />
            {updating ? (
              <span className="text-[12.5px] text-ink-2">{copy.UPDATING}</span>
            ) : null}
          </div>
        </div>
      </div>
      {person.archived ? (
        <p className="text-[13px] text-ink-2" data-archived-person="">
          {copy.ARCHIVED_PERSON}
        </p>
      ) : null}
      <div className="flex flex-wrap items-start gap-2">
        {shown.projected ? (
          <Button disabled reason={copy.WAIT_FOR_SYNC_PERSON}>
            {copy.MANAGE_SHARING}
          </Button>
        ) : (
          <Button
            data-people-action="manage-sharing"
            onClick={() => setSharing(true)}
          >
            {copy.MANAGE_SHARING}
          </Button>
        )}
        {headerActions?.(person.id)}
        <DuplicatesEntry personId={person.id} projected={shown.projected} />
        <RenameEntry
          shown={shown}
          linkage={linkage}
          open={renaming}
          onOpen={() => setRenaming(true)}
        />
        <UnlinkEntry
          linkage={linkage}
          name={person.label}
          onOpen={() => setUnlinking(true)}
        />
        <ArchiveEntry shown={shown} />
      </div>
      {renaming ? (
        <RenameForm
          shown={shown}
          linkage={linkage}
          drafts={drafts}
          onDone={() => setRenaming(false)}
        />
      ) : null}
      {unlinking && linkage.known ? (
        <UnlinkDialog
          personId={person.id}
          version={linkage.version}
          onClose={() => setUnlinking(false)}
        />
      ) : null}
      <ResourcePolicyEditor
        resourceId={person.id}
        open={sharing}
        onOpenChange={(open) => {
          setSharing(open);
          // What the editor sent (its commands are online, outside the queue) changes the summaries shown.
          if (!open) env.memory.invalidateSummaries();
        }}
      />
    </section>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[22px] font-semibold tracking-[-0.025em] text-ink-1">
      {children}
    </h2>
  );
}

function LinkageLine({
  linkage,
  name,
  online,
  onRetry,
}: {
  linkage: LinkageState;
  name: string;
  online: boolean;
  onRetry(): void;
}) {
  if (linkage.known)
    return (
      <p className="text-[13px] text-ink-2" data-linkage={linkage.kind}>
        {linkage.kind === "self"
          ? copy.LINK_SELF
          : linkage.kind === "other"
            ? copy.LINK_OTHER(name)
            : copy.LINK_NONE}
      </p>
    );
  return (
    <div className="flex flex-wrap items-center gap-2" data-linkage="unknown">
      <p className="text-[13px] text-ink-2">
        {copy.LINK_UNKNOWN}. {copy.LINK_UNKNOWN_REASON[linkage.reason]}
      </p>
      {online &&
      (linkage.reason === "failed" || linkage.reason === "refused") ? (
        <Button variant="quiet" onClick={onRetry}>
          {copy.TRY_AGAIN}
        </Button>
      ) : null}
    </div>
  );
}

function DuplicatesEntry({
  personId,
  projected,
}: {
  personId: string;
  projected: boolean;
}) {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  useEffect(() => {
    if (!env.online || projected || env.memory.duplicateCounts.has(personId))
      return;
    const memory = env.memory;
    memory.duplicateCounts.set(personId, null);
    void env.api.readDuplicates(personId, { limit: 50 }).then((result) => {
      if (!isCurrentMemory(memory)) return;
      if (result.ok)
        memory.duplicateCounts.set(personId, firstPageCount(result.value));
      else memory.duplicateCounts.delete(personId);
      memory.touch();
    });
  }, [env, personId, projected]);
  if (!env.online || projected)
    return (
      <Button
        disabled
        reason={projected ? copy.WAIT_FOR_SYNC_PERSON : copy.DUPLICATES_OFFLINE}
      >
        {copy.POSSIBLE_DUPLICATES}
      </Button>
    );
  const count = env.memory.duplicateCounts.get(personId) ?? null;
  return (
    <Link
      to="/people/$personId/duplicates"
      params={{ personId }}
      data-people-action="duplicates"
      className="atlas-transition inline-flex min-h-11 items-center gap-2 rounded-control border border-hairline-strong bg-raised px-4 text-[13.5px] text-ink-1 hover:bg-row-hover"
    >
      {copy.POSSIBLE_DUPLICATES}
      {count === null ? null : (
        <span className="font-num text-ink-2" data-duplicates-count="">
          {count}
        </span>
      )}
    </Link>
  );
}

function RenameEntry({
  shown,
  linkage,
  open,
  onOpen,
}: {
  shown: ShownRow;
  linkage: LinkageState;
  open: boolean;
  onOpen(): void;
}) {
  if (open) return null;
  const route = renameRoute(linkage, shown.row.can_edit);
  if (shown.projected)
    return (
      <Button disabled reason={copy.WAIT_FOR_SYNC_PERSON}>
        {copy.RENAME}
      </Button>
    );
  if (route.kind === "disabled")
    return (
      <Button
        disabled
        reason={
          route.reason === "other_owns"
            ? copy.RENAME_OTHER_OWNS(shown.row.label)
            : route.reason === "unknown"
              ? copy.RENAME_UNKNOWN
              : copy.RENAME_CANNOT_EDIT
        }
      >
        {copy.RENAME}
      </Button>
    );
  return (
    <Button data-people-action="rename" onClick={onOpen}>
      {copy.RENAME}
    </Button>
  );
}

function failureMessage(failure: PeopleFailure): string | null {
  switch (failure.kind) {
    case "conflict":
    case "operation_conflict":
      return copy.CONFLICT;
    case "forbidden":
      return copy.FORBIDDEN_PROFILE;
    case "uncertain":
      return copy.UNCERTAIN;
    case "offline":
    case "not_sent":
      return copy.NEEDS_CONNECTION;
    case "closed":
      return null;
    default:
      return copy.REFUSED.storage;
  }
}

/**
 * The inline rename form (Q21 `profile-rename-unlink.html`): "Name", Save and Cancel. While saving, Save shows its state and the form is
 * locked (no resubmission). Success closes it. A conflict keeps the typed text ("Someone else already changed this — reload and try
 * again."). `rename_profile` needs a connection (Save is disabled with the reason); the unlinked person's content edit queues.
 */
interface RetainedRename {
  name: string;
  /** The versions the form opened on (Q21: captured when the form opens; finding 1 of the review of 13 October). */
  snapshot: EditSnapshot;
}

function RenameForm({
  shown,
  linkage,
  drafts,
  onDone,
}: {
  shown: ShownRow;
  linkage: LinkageState;
  drafts: readonly DraftWithCommand[];
  onDone(): void;
}) {
  const env = usePeopleEnv();
  const announcer = useAnnouncer();
  const save = useOutboxSave();
  const person = shown.row;
  const route = renameRoute(linkage, person.can_edit);
  const retainedKey = `rename:${person.id}`;
  const [initial] = useState<RetainedRename>(() => {
    const kept = env.memory.drafts.get(retainedKey) as
      | RetainedRename
      | undefined;
    return (
      kept ?? {
        name: person.label,
        snapshot: snapshotOf(person, drafts, shown.latest?.localId ?? null),
      }
    );
  });
  // The outstanding saves as they are read NOW (a save decides on the latest read, not the one of the render that started it).
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [name, setName] = useState(initial.name);
  const [snapshot, setSnapshot] = useState(initial.snapshot);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    requestId?: string;
    reload?: boolean;
  } | null>(null);
  const errorId = useId();
  const max = route.kind === "rename_profile" ? 200 : 300;
  // The typed name is kept across a remount of the tree (a 403 elsewhere), for this identity and this person only.
  useEffect(() => {
    env.memory.drafts.set(retainedKey, {
      name,
      snapshot,
    } satisfies RetainedRename);
  }, [env, retainedKey, name, snapshot]);
  /** The person changed since the form opened: nothing is sent; the form is re-bound to the person as shown now, for a deliberate re-save. */
  const stale = () => {
    setSnapshot(snapshotOf(person, drafts, shown.latest?.localId ?? null));
    setMessage({ text: copy.STALE_RENAME });
  };
  const close = () => {
    env.memory.drafts.delete(retainedKey);
    onDone();
  };

  const submit = async () => {
    if (saving) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setMessage({ text: copy.PROBLEM.name_missing as string });
      return;
    }
    if (charCount(trimmed) > max) {
      setMessage({
        text: (max === 200
          ? copy.PROBLEM.rename_too_long
          : copy.PROBLEM.name_too_long) as string,
      });
      return;
    }
    setMessage(null);
    if (!stillBound(snapshot, person)) return stale();
    setSaving(true);
    if (route.kind === "rename_profile") {
      const version = snapshot.version;
      const body = renameProfileBody({
        personId: person.id,
        version,
        name: trimmed,
      });
      const result = await sendOnline(
        env,
        `rename:${person.id}`,
        body,
        (attempt) => env.api.peopleCommand(attempt),
      );
      setSaving(false);
      if (result.ok) {
        env.memory.drafts.set(`renaming:${person.id}`, version);
        readLinkage(env, person.id, { force: true });
        announcer.announce(copy.RENAMED, "polite");
        close();
        return;
      }
      if (result.kind === "forbidden")
        readLinkage(env, person.id, { force: true });
      const text = failureMessage(result);
      if (text !== null)
        setMessage({
          text,
          ...("requestId" in result && result.requestId
            ? { requestId: result.requestId }
            : {}),
          reload: result.kind === "conflict",
        });
      return;
    }
    if (route.kind !== "edit" || snapshot.policyVersion === null) {
      setSaving(false);
      setMessage({ text: copy.WAIT_FOR_SYNC_PERSON });
      return;
    }
    const input = {
      personId: person.id,
      name: trimmed,
      policyVersion: snapshot.policyVersion,
    };
    const guard = baseGuard(snapshot.expectedBase);
    const latest = shown.latest;
    // The rename was typed over a body that is no longer the one stored (review 2, finding 3): nothing is written; it is reviewed again.
    let reviewAgain = false;
    const outcome = await save(async (outbox) => {
      // D-11a-15: the unsent rename the form OPENED on is edited in place, while it is stored exactly as the form read it.
      let refusal: Parameters<typeof successorFollows>[0] = null;
      if (
        latest?.kind === "edit" &&
        latest.status === "queued" &&
        latest.localId === snapshot.latestLocalId
      ) {
        const edited = await outbox.editQueued(latest.localId, {
          ...renameEditRequest(input),
          expectDraft: reviewedDraft(snapshot),
        });
        if (edited.kind === "edited") return edited;
        if (
          edited.reason !== "not_queued" &&
          edited.reason !== "not_found" &&
          edited.reason !== "retargeted" &&
          edited.reason !== "draft_changed"
        )
          return edited;
        refusal = edited.reason;
      }
      if (!successorFollows(refusal, snapshot, draftsRef.current)) {
        reviewAgain = true;
        return { kind: "refused", reason: "draft_changed" } as const;
      }
      return outbox.enqueue(renameEditRequest({ ...input, guard }));
    });
    setSaving(false);
    if (guard.moved || reviewAgain) return stale();
    if (!outcome.ok) {
      if (outcome.message !== null) setMessage({ text: outcome.message });
      return;
    }
    announcer.announce(copy.SAVED_NOT_SENT, "polite");
    close();
  };

  const offlineBlocked = route.kind === "rename_profile" && !env.online;
  const reason = !env.writable
    ? copy.READ_ONLY_COMPAT
    : offlineBlocked
      ? copy.NEEDS_CONNECTION
      : saving
        ? copy.SAVING
        : null;
  return (
    <form
      data-rename-form=""
      className="flex max-w-[440px] flex-col gap-2 rounded-row border border-hairline-strong bg-panel p-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (reason === null) void submit();
      }}
    >
      <fieldset disabled={saving} className="flex flex-col gap-2">
        <Input
          label={copy.NAME}
          value={name}
          surface="panel"
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? errorId : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        {message ? (
          <div id={errorId} className="flex flex-col items-start gap-1">
            <p className="text-[12.5px] text-conflict-text">{message.text}</p>
            {message.requestId ? (
              <p className="font-num select-all text-[12px] text-ink-2">
                Reference: {message.requestId}
              </p>
            ) : null}
            {message.reload ? (
              <Button
                variant="quiet"
                onClick={() => readLinkage(env, person.id, { force: true })}
              >
                {copy.RELOAD}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-start gap-2">
          {reason === null ? (
            <Button
              variant="primary"
              type="submit"
              data-people-action="save-rename"
            >
              {copy.SAVE}
            </Button>
          ) : (
            <Button variant="primary" disabled reason={reason}>
              {copy.SAVE}
            </Button>
          )}
          <Button variant="quiet" onClick={close}>
            {copy.CANCEL}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function UnlinkEntry({
  linkage,
  name,
  onOpen,
}: {
  linkage: LinkageState;
  name: string;
  onOpen(): void;
}) {
  const env = usePeopleEnv();
  const offer = unlinkOffer(linkage);
  if (offer.kind === "absent") return null;
  if (offer.kind === "disabled")
    return (
      <Button disabled reason={copy.UNLINK_OTHER(name)}>
        {copy.UNLINK}
      </Button>
    );
  if (!env.online)
    return (
      <Button disabled reason={copy.NEEDS_CONNECTION}>
        {copy.UNLINK}
      </Button>
    );
  return (
    <Button data-people-action="unlink" onClick={onOpen}>
      {copy.UNLINK}
    </Button>
  );
}

function UnlinkDialog({
  personId,
  version,
  onClose,
}: {
  personId: string;
  version: number;
  onClose(): void;
}) {
  const env = usePeopleEnv();
  const announcer = useAnnouncer();
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    requestId?: string;
  } | null>(null);
  const confirm = async () => {
    if (sending) return;
    setSending(true);
    setMessage(null);
    const result = await sendOnline(
      env,
      `unlink:${personId}`,
      unlinkBody({ personId, version }),
      (attempt) => env.api.peopleCommand(attempt),
    );
    setSending(false);
    readLinkage(env, personId, { force: true });
    if (result.ok) {
      announcer.announce(copy.UNLINKED, "polite");
      onClose();
      return;
    }
    const text = failureMessage(result);
    if (text !== null)
      setMessage({
        text,
        ...("requestId" in result && result.requestId
          ? { requestId: result.requestId }
          : {}),
      });
  };
  const reason = !env.writable
    ? copy.READ_ONLY_COMPAT
    : !env.online
      ? copy.NEEDS_CONNECTION
      : sending
        ? copy.SAVING
        : null;
  return (
    <Dialog
      open
      title={copy.UNLINK_TITLE}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            {copy.CANCEL}
          </Button>
          <span className="ml-auto">
            {reason === null ? (
              <Button
                variant="primary"
                data-people-action="confirm-unlink"
                onClick={() => void confirm()}
              >
                {copy.UNLINK}
              </Button>
            ) : (
              <Button variant="primary" disabled reason={reason}>
                {copy.UNLINK}
              </Button>
            )}
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13.5px] leading-[1.6] text-ink-1">
          {copy.UNLINK_BODY}
        </p>
        {message ? (
          <Banner message={message.text} requestId={message.requestId} />
        ) : null}
      </div>
    </Dialog>
  );
}

/** Archive / Restore of the person (D-11a-10): a queued `archive`, offline-capable, no confirmation (none is drawn). */
function ArchiveEntry({ shown }: { shown: ShownRow }) {
  const env = usePeopleEnv();
  const announcer = useAnnouncer();
  const save = useOutboxSave();
  const [message, setMessage] = useState<string | null>(null);
  const person = shown.row;
  const label = person.archived ? copy.RESTORE : copy.ARCHIVE;
  if (shown.projected)
    return (
      <Button variant="quiet" disabled reason={copy.WAIT_FOR_SYNC_PERSON}>
        {label}
      </Button>
    );
  if (!person.can_edit)
    return (
      <Button variant="quiet" disabled reason={copy.RENAME_CANNOT_EDIT}>
        {label}
      </Button>
    );
  if (!env.writable)
    return (
      <Button variant="quiet" disabled reason={copy.READ_ONLY_COMPAT}>
        {label}
      </Button>
    );
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="quiet"
        data-people-action={
          person.archived ? "restore-person" : "archive-person"
        }
        onClick={async () => {
          const outcome = await save((outbox) =>
            outbox.enqueue(
              archiveRequest({ id: person.id, archived: !person.archived }),
            ),
          );
          if (outcome.ok) {
            setMessage(null);
            announcer.announce(copy.SAVED_NOT_SENT, "polite");
          } else if (outcome.message !== null) setMessage(outcome.message);
        }}
      >
        {label}
      </Button>
      {message ? (
        <span className="text-[12px] text-conflict-text">{message}</span>
      ) : null}
    </span>
  );
}
