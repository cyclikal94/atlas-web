import { Link } from "@tanstack/react-router";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { PageHeading } from "../../../components/ui/page-heading";
import type { DraftWithCommand } from "../../../data";
import { ResourcePolicyEditor } from "../../sharing";
import type { PeopleFailure } from "../api";
import { useArchiveAction } from "../archive";
import * as copy from "../copy";
import { usePeopleEnv } from "../env";
import {
  admit,
  completeSession,
  isPending,
  reportSession,
  retireSession,
  sessionOf,
  settle,
  useEditingSession,
} from "../lifetime";
import {
  isCurrentMemory,
  type PeopleMemory,
  useMemoryRevision,
} from "../memory";
import { attemptVersion, replayFor } from "../model/attempt";
import {
  baseGuard,
  renameEditRequest,
  renameProfileBody,
  unlinkBody,
} from "../model/commands";
import { firstPageCount } from "../model/duplicates";
import {
  type LinkageState,
  type RenameRoute,
  renameRoute,
  unlinkOffer,
} from "../model/linkage";
import type { ShownRow } from "../model/project";
import { isMergedAlias } from "../model/requests";
import {
  type EditSnapshot,
  followsOf,
  reviewedDraft,
  snapshotOf,
  stillBound,
  successorFollows,
} from "../model/snapshot";
import { charCount } from "../model/values";
import { replayOnline, sendOnline } from "../online";
import { Avatar, Banner, PendingBadge, useOutboxSave } from "../parts";
import { linkageIn, readLinkage, usePersonLinkage } from "../reads";
import * as requestsCopy from "../requests/copy";

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
  // The synced row's version is known of the person too (an unsent create's projection has none): an older linkage answer is not current.
  const synced = shown.projected ? undefined : person.version;
  const { linkage, retry } = usePersonLinkage(person.id, synced);
  const [renaming, setRenaming] = useState(false);
  // The version the open unlink confirmation was opened on: it confirms that unlink only, never one of a later linkage (review 25).
  const [unlinking, setUnlinking] = useState<number | null>(null);
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
              <span className="text-xs text-muted-foreground">
                {copy.ARCHIVED_TAG}
              </span>
            ) : null}
            <PendingBadge mark={shown.pending} />
            {updating ? (
              <span className="text-xs text-muted-foreground">
                {copy.UPDATING}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {person.archived ? (
        <p className="text-sm text-muted-foreground" data-archived-person="">
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
          retained={env.memory.attempts.has(`rename:${person.id}`)}
          onOpen={() => setRenaming(true)}
        />
        <UnlinkEntry
          linkage={linkage}
          name={person.label}
          retained={unlinkReplay(env.memory, person.id) !== null}
          onOpen={() => {
            // An uncertain unlink is confirmed again as it was made: on its own version, whatever is read now (review 26, R26.1).
            const replay = unlinkReplay(env.memory, person.id);
            const version =
              replay !== null
                ? attemptVersion(replay)
                : linkage.known
                  ? linkage.version
                  : null;
            if (version !== null) setUnlinking(version);
          }}
        />
        <ArchiveEntry shown={shown} />
      </div>
      {renaming ? (
        <RenameForm
          shown={shown}
          linkage={linkage}
          synced={synced}
          drafts={drafts}
          onDone={() => setRenaming(false)}
        />
      ) : null}
      {unlinking !== null ? (
        <UnlinkDialog
          personId={person.id}
          name={person.label}
          version={unlinking}
          linkage={linkage}
          synced={synced}
          onClose={() => setUnlinking(null)}
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
    <h2 className="text-2xl font-semibold tracking-[-0.025em] text-foreground">
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
      <p className="text-sm text-muted-foreground" data-linkage={linkage.kind}>
        {linkage.kind === "self"
          ? copy.LINK_SELF
          : linkage.kind === "other"
            ? copy.LINK_OTHER(name)
            : copy.LINK_NONE}
      </p>
    );
  return (
    <div className="flex flex-wrap items-center gap-2" data-linkage="unknown">
      <p className="text-sm text-muted-foreground">
        {copy.LINK_UNKNOWN}. {copy.LINK_UNKNOWN_REASON[linkage.reason]}
      </p>
      {online &&
      (linkage.reason === "failed" || linkage.reason === "refused") ? (
        <Button variant="ghost" onClick={onRetry}>
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
      className="atlas-transition inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-card px-4 text-sm text-foreground hover:bg-accent"
    >
      {copy.POSSIBLE_DUPLICATES}
      {count === null ? null : (
        <span
          className="font-num text-muted-foreground"
          data-duplicates-count=""
        >
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
  retained,
  onOpen,
}: {
  shown: ShownRow;
  linkage: LinkageState;
  open: boolean;
  /** A rename whose outcome is uncertain is kept: the form stays reachable to try it again, whoever the person is linked to now. */
  retained: boolean;
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
  if (route.kind === "disabled" && !retained)
    return (
      <Button disabled reason={renameDisabled(route.reason, shown.row.label)}>
        {copy.RENAME}
      </Button>
    );
  return (
    <Button data-people-action="rename" onClick={onOpen}>
      {copy.RENAME}
    </Button>
  );
}

const renameDisabled = (
  reason: Extract<RenameRoute, { kind: "disabled" }>["reason"],
  name: string,
): string =>
  reason === "other_owns"
    ? copy.RENAME_OTHER_OWNS(name)
    : reason === "unknown"
      ? copy.RENAME_UNKNOWN
      : copy.RENAME_CANNOT_EDIT;

/**
 * The uncertain rename a Save of `name` resolves (review 26, R26.2): the kept attempt, when `name` is what it sent. It is sent again as it
 * was (its key, its body, its version and endpoint) before anything about the person as read now is asked; only a changed name is a new
 * rename, judged on the person and linkage read now.
 */
const renameReplay = (memory: PeopleMemory, personId: string, name: string) =>
  replayFor(memory.attempts.get(`rename:${personId}`) ?? null, (version) =>
    renameProfileBody({ personId, version, name: name.trim() }),
  );

/** The uncertain unlink of the person (review 26, R26.1): resolved with its own request, never judged as a new unlink. */
const unlinkReplay = (memory: PeopleMemory, personId: string) =>
  replayFor(memory.attempts.get(`unlink:${personId}`) ?? null, (version) =>
    unlinkBody({ personId, version }),
  );

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
interface RenameMessage {
  text: string;
  requestId?: string;
  reload?: boolean;
}

/** What a rename tells the form showing its session now (`reportSession`): its message, and the re-binding after a stale save. */
interface RenameReport {
  message?: RenameMessage | null;
  snapshot?: EditSnapshot;
}

interface RetainedRename {
  /** The editing session (`lifetime.ts`): a completed rename ends only the session it was typed in (review 6, finding 1). */
  session: string;
  name: string;
  /** Bumped by every keystroke: a rename that completes for an earlier revision keeps the later name. */
  revision: number;
  /** The versions the form opened on (Q21: captured when the form opens; finding 1 of the review of 13 October). */
  snapshot: EditSnapshot;
}

function RenameForm({
  shown,
  linkage,
  synced,
  drafts,
  onDone,
}: {
  shown: ShownRow;
  linkage: LinkageState;
  /** The synced row's version (`linkageIn`). */
  synced: number | undefined;
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
    if (kept !== undefined)
      return { ...kept, session: sessionOf(kept) ?? env.newId() };
    return {
      session: env.newId(),
      name: person.label,
      revision: 0,
      snapshot: snapshotOf(person, drafts, shown.latest?.localId ?? null),
    };
  });
  const session = initial.session;
  // The outstanding saves as they are read NOW (a save decides on the latest read, not the one of the render that started it).
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  // The person and its newest outstanding change as shown NOW, for re-binding after a refusal (review 12: not the render that saved).
  const shownRef = useRef({ person, latest: shown.latest });
  shownRef.current = { person, latest: shown.latest };
  const [name, setName] = useState(initial.name);
  const [revision, setRevision] = useState(initial.revision ?? 0);
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const [snapshot, setSnapshot] = useState(initial.snapshot);
  useMemoryRevision(env.memory);
  // Whether this session's rename runs, whichever mount of it started it (review 7, finding 1).
  const saving = isPending(env.memory, session);
  const [message, setMessage] = useState<RenameMessage | null>(null);
  const errorId = useId();
  const max = route.kind === "rename_profile" ? 200 : 300;
  // The typed name is kept across a remount of the tree (a 403 elsewhere), for this identity and this person only.
  // Nothing of this form keeps it again once the session ended (review 8, finding 1).
  const retired = useRef(false);
  useEffect(() => {
    if (retired.current) return;
    env.memory.drafts.set(retainedKey, {
      session,
      name,
      revision,
      snapshot,
    } satisfies RetainedRename);
  }, [env, retainedKey, session, name, revision, snapshot]);
  /**
   * The person changed since the form opened: nothing is sent; the form is re-bound to the person as shown now, for a deliberate re-save.
   * "Now" is the page's latest read (review 12), not the render that started the refused save: that one still shows the body the refusal
   * was about, and a re-save bound to it would only be refused again.
   */
  const stale = () => {
    const now = shownRef.current;
    tell({
      snapshot: snapshotOf(
        now.person,
        draftsRef.current,
        now.latest?.localId ?? null,
      ),
      message: { text: copy.STALE_RENAME },
    });
  };
  const close = () => {
    retired.current = true;
    retireSession(env.memory, retainedKey, session);
    onDone();
  };
  const owns = useEditingSession<RenameReport>(env.memory, session, {
    revision: () => revisionRef.current,
    close,
    keep: () => setMessage({ text: copy.LATER_EDITS_KEPT }),
    report: (update) => {
      if (update.snapshot !== undefined) setSnapshot(update.snapshot);
      if (update.message !== undefined) setMessage(update.message);
    },
  });
  /** What this session's rename says, to the form showing the session now (the one that submitted may have been remounted since). */
  const tell = (update: RenameReport) =>
    reportSession(env.memory, retainedKey, session, update);
  /** A save of this session at `ticket` completed: only this session ends (a later rename form is never closed by it). */
  const ended = (ticket: number) =>
    completeSession(
      env.memory,
      retainedKey,
      session,
      ticket,
      (kept) => (kept as RetainedRename).revision,
    );

  /** Renames once per SESSION at a time: admitted synchronously, before anything is awaited (review 7, finding 1). */
  const submit = async () => {
    if (!owns()) return;
    const admission = admit(env.memory, [session], env.newId);
    if (admission === null) return;
    try {
      await run();
    } finally {
      settle(admission);
    }
  };
  /** What an online rename's answer does to the form: success ends the session at `ticket`; anything else is shown. */
  const answered = (
    result: Awaited<ReturnType<typeof env.api.peopleCommand>>,
    version: number,
    ticket: number,
  ) => {
    if (result.ok) {
      env.memory.drafts.set(`renaming:${person.id}`, version);
      readLinkage(env, person.id, { force: true });
      announcer.announce(copy.RENAMED, "polite");
      ended(ticket);
      return;
    }
    if (result.kind === "forbidden")
      readLinkage(env, person.id, { force: true });
    const text = failureMessage(result);
    if (text !== null)
      tell({
        message: {
          text,
          ...("requestId" in result && result.requestId
            ? { requestId: result.requestId }
            : {}),
          reload: result.kind === "conflict",
        },
      });
  };
  const run = async () => {
    // The uncertain rename of this name is resolved first, exactly as it was sent (review 26, R26.2): not judged on the linkage, the
    // person's version or the form's binding as read now, and never re-bound (a sync of its own commit would otherwise make it "stale").
    const replay = renameReplay(env.memory, person.id, name);
    if (replay !== null) {
      setMessage(null);
      const ticket = revision;
      const result = await replayOnline(
        env,
        `rename:${person.id}`,
        replay,
        (attempt) => env.api.peopleCommand(attempt),
      );
      answered(result, attemptVersion(replay) as number, ticket);
      return;
    }
    // Who controls the name is judged at the press (review 25): a press of a render whose linkage is no longer current sends nothing; the
    // form, its typed name kept, shows why it cannot save now.
    if (
      renameRoute(linkageIn(env, person.id, synced), person.can_edit).kind !==
      route.kind
    )
      return;
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
    const ticket = revision;
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
      answered(result, version, ticket);
      return;
    }
    if (route.kind !== "edit" || snapshot.policyVersion === null) {
      tell({ message: { text: copy.WAIT_FOR_SYNC_PERSON } });
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
          // Only while no later rename of the person follows it (D-11a-15, review 12): that save was built over this body.
          expectLatest: true,
        });
        if (edited.kind === "edited") return edited;
        if (
          edited.reason !== "not_queued" &&
          edited.reason !== "not_found" &&
          edited.reason !== "retargeted" &&
          edited.reason !== "draft_changed" &&
          edited.reason !== "not_latest"
        )
          return edited;
        refusal = edited.reason;
      }
      if (!successorFollows(refusal, snapshot, draftsRef.current)) {
        reviewAgain = true;
        return { kind: "refused", reason: "draft_changed" } as const;
      }
      // Judged again in the writing transaction (review 12, R12.1): the rename follows the save it was typed over only while that save is
      // stored with the body the form read.
      const queued = await outbox.enqueue({
        ...renameEditRequest({ ...input, guard }),
        ...followsOf(snapshot, person.id),
      });
      if (queued.kind === "refused" && queued.reason === "predecessor_changed")
        reviewAgain = true;
      return queued;
    });
    if (guard.moved || reviewAgain) return stale();
    if (!outcome.ok) {
      if (outcome.message !== null)
        tell({ message: { text: outcome.message } });
      return;
    }
    announcer.announce(copy.SAVED_NOT_SENT, "polite");
    ended(ticket);
  };

  const offlineBlocked = route.kind === "rename_profile" && !env.online;
  // A Save that tries the uncertain rename again needs only the connection: not the linkage or version read now (review 26).
  const replaying = renameReplay(env.memory, person.id, name) !== null;
  const reason = !env.writable
    ? copy.READ_ONLY_COMPAT
    : saving
      ? copy.SAVING
      : replaying
        ? env.online
          ? null
          : copy.NEEDS_CONNECTION
        : route.kind === "disabled"
          ? renameDisabled(route.reason, person.label)
          : offlineBlocked
            ? copy.NEEDS_CONNECTION
            : null;
  return (
    <form
      data-rename-form=""
      className="flex max-w-[440px] flex-col gap-2 rounded-lg border border-border bg-card p-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (reason === null) void submit();
      }}
    >
      <fieldset disabled={saving} className="flex flex-col gap-2">
        <Input
          label={copy.NAME}
          value={name}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? errorId : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setRevision((value) => value + 1);
          }}
        />
        {message ? (
          <div id={errorId} className="flex flex-col items-start gap-1">
            <p className="text-xs text-destructive">{message.text}</p>
            {message.requestId ? (
              <p className="font-num select-all text-xs text-muted-foreground">
                Reference: {message.requestId}
              </p>
            ) : null}
            {message.reload ? (
              <Button
                variant="ghost"
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
              variant="default"
              type="submit"
              data-people-action="save-rename"
            >
              {copy.SAVE}
            </Button>
          ) : (
            <Button variant="default" disabled reason={reason}>
              {copy.SAVE}
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
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
  retained,
  onOpen,
}: {
  linkage: LinkageState;
  name: string;
  /**
   * An unlink whose outcome is uncertain is kept (review 26, R26.1): it stays reachable, to be tried again as it was, even when the linkage
   * read now offers no new unlink (its own commit, read back, says "not linked"; a remount closed its confirmation).
   */
  retained: boolean;
  onOpen(): void;
}) {
  const env = usePeopleEnv();
  const offer = retained ? { kind: "enabled" as const } : unlinkOffer(linkage);
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

/**
 * Whether the confirmation bound to `version` still confirms an unlink the person can make (review 25): the CURRENT linkage is the signed-in
 * account's, at that version. Otherwise why not. It is bound again only after its own unlink was refused as a conflict ("reload and try
 * again"), and only to the signed-in account's own linkage read after that; never to another account's or to none.
 */
function unlinkBlocked(
  linkage: LinkageState,
  version: number,
  name: string,
): string | null {
  if (!linkage.known)
    return `${copy.LINK_UNKNOWN}. ${copy.LINK_UNKNOWN_REASON[linkage.reason]}`;
  if (linkage.kind === "other") return copy.UNLINK_OTHER(name);
  if (linkage.kind === "unlinked") return copy.LINK_NONE;
  return linkage.version === version ? null : copy.CONFLICT;
}

function UnlinkDialog({
  personId,
  name,
  version,
  linkage,
  synced,
  onClose,
}: {
  personId: string;
  name: string;
  /** The version the confirmation was opened on (the unlink's guard). */
  version: number;
  linkage: LinkageState;
  synced: number | undefined;
  onClose(): void;
}) {
  const env = usePeopleEnv();
  const announcer = useAnnouncer();
  useMemoryRevision(env.memory);
  const [bound, setBound] = useState(version);
  // Its unlink was refused as a conflict: the person was told to try again on the person as read again.
  const [conflicted, setConflicted] = useState(false);
  useEffect(() => {
    if (
      conflicted &&
      linkage.known &&
      linkage.kind === "self" &&
      linkage.version > bound
    ) {
      setBound(linkage.version);
      setConflicted(false);
    }
  }, [conflicted, linkage, bound]);
  // One unlink of the person at a time, whichever confirmation asks (review 7, finding 1): a confirmation opened again while one is
  // sent shows it sending, and sends nothing more.
  const target = `unlink:${personId}`;
  const sending = isPending(env.memory, target);
  // A confirmation that completes after this dialog was closed never closes a later one (review 6, finding 1).
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The uncertain unlink of the person, kept: this confirmation tries IT again (review 26, R26.1), and says so when opened on it.
  const replaying = unlinkReplay(env.memory, personId) !== null;
  const [message, setMessage] = useState<{
    text: string;
    requestId?: string;
  } | null>(() => (replaying ? { text: copy.UNCERTAIN } : null));
  const confirm = async () => {
    // An uncertain unlink is resolved first, with its own key and body: what is read since (its own commit read back as "not linked", a
    // later version) is no reason to refuse it, and is never adopted into it (review 26, R26.1).
    const replay = unlinkReplay(env.memory, personId);
    // A NEW unlink is judged at the press, on what the page knows NOW (a press of an earlier render never unlinks another linkage or
    // version).
    if (
      replay === null &&
      unlinkBlocked(linkageIn(env, personId, synced), bound, name) !== null
    )
      return;
    const admission = admit(env.memory, [target], env.newId);
    if (admission === null) return;
    setMessage(null);
    let result: Awaited<ReturnType<typeof env.api.peopleCommand>>;
    try {
      const send = (attempt: Parameters<typeof env.api.peopleCommand>[0]) =>
        env.api.peopleCommand(attempt);
      result =
        replay !== null
          ? await replayOnline(env, target, replay, send)
          : await sendOnline(
              env,
              target,
              unlinkBody({ personId, version: bound }),
              send,
            );
    } finally {
      settle(admission);
    }
    readLinkage(env, personId, { force: true });
    if (result.ok) {
      announcer.announce(copy.UNLINKED, "polite");
      if (mounted.current) onClose();
      return;
    }
    const text = failureMessage(result);
    if (!mounted.current) return;
    if (result.kind === "conflict") setConflicted(true);
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
        : replaying
          ? null
          : unlinkBlocked(linkage, bound, name);
  return (
    <Dialog
      open
      title={copy.UNLINK_TITLE}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {copy.CANCEL}
          </Button>
          <span className="ml-auto">
            {reason === null ? (
              <Button
                variant="default"
                data-people-action="confirm-unlink"
                onClick={() => void confirm()}
              >
                {copy.UNLINK}
              </Button>
            ) : (
              <Button variant="default" disabled reason={reason}>
                {copy.UNLINK}
              </Button>
            )}
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm leading-[1.6] text-foreground">
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
  const person = shown.row;
  const label = person.archived ? copy.RESTORE : copy.ARCHIVE;
  // One archive or restore of the person at a time, whichever view asks (review 7, finding 1; review 8, finding 2).
  const action = useArchiveAction(person.id);
  // WEB-11b (D-11b-12): a merged alias is never archived or restored by itself (the backend redirects `archive` of an alias to its
  // canonical person, so a press would act on the OTHER person).
  if (isMergedAlias(person) !== null)
    return (
      <Button variant="ghost" disabled reason={requestsCopy.ALIAS_NO_RESTORE}>
        {label}
      </Button>
    );
  if (shown.projected)
    return (
      <Button variant="ghost" disabled reason={copy.WAIT_FOR_SYNC_PERSON}>
        {label}
      </Button>
    );
  if (!person.can_edit)
    return (
      <Button variant="ghost" disabled reason={copy.RENAME_CANNOT_EDIT}>
        {label}
      </Button>
    );
  if (!env.writable)
    return (
      <Button variant="ghost" disabled reason={copy.READ_ONLY_COMPAT}>
        {label}
      </Button>
    );
  if (action.pending)
    return (
      <Button variant="ghost" disabled reason={copy.SAVING}>
        {label}
      </Button>
    );
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="ghost"
        data-people-action={
          person.archived ? "restore-person" : "archive-person"
        }
        onClick={() => void action.run(!person.archived, person.version)}
      >
        {label}
      </Button>
      {action.message ? (
        <span className="text-xs text-destructive">{action.message}</span>
      ) : null}
    </span>
  );
}
