import { useEffect, useMemo, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import {
  type Policy,
  type ResourceId,
  useDraftQueue,
  useMergedUnder,
} from "../../data";
import {
  useRecoverableEditor,
  useRecoveryHost,
} from "../../lib/form-recovery/editor";
import { firstControl } from "../../lib/form-recovery/focus";
import { RecoveryNotice } from "../../lib/form-recovery/RecoveryNotice";
import { AudienceSummary } from "./AudienceSummary";
import {
  type DirectoryEntry,
  type ManagementCommand,
  type PolicyState,
  type SharingFailure,
  type SharingResult,
  untilSent,
} from "./api";
import * as copy from "./copy";
import { DirectoryLookup } from "./DirectoryLookup";
import { SharingBoundary, useSharingEnv } from "./env";
import { knownMembership, useMembership } from "./membership";
import { effectiveAudience, labelsFrom } from "./model/audience";
import {
  emptyPolicy,
  type PolicyAction,
  type PolicyDraftState,
  reducePolicy,
  samePolicy,
  toWirePolicy,
} from "./model/policy-draft";
import {
  decodePolicyDraft,
  encodePolicyDraft,
  policyFormContext,
} from "./model/recovery-fields";
import { type Attempt, nextAttempt } from "./model/submission";
import { PolicyGrantsEditor } from "./PolicyGrantsEditor";
import { Banner, formatWhen, useSharingLoad } from "./parts";
import { retainedSession } from "./retained";

/**
 * WF-SHARING-04, the resource policy editor: a STANDALONE, resource-kind-agnostic component (WEB-12a's public interface). It opens on any
 * resource the cache holds, shows its effective visibility as edited, and replaces its policy with `replace_policy`, guarded by the policy
 * version read from `GET /policies/{id}` when it opened (D-12a-3). Online-only (D-12a-1): nothing about a policy is stored on the device,
 * nothing is queued, and Save is disabled while offline with the reason beside it. Nothing here knows what kind of resource it is.
 *
 * A dialog on desktop; below the desktop breakpoint a full-bleed sheet, as the accepted tablet frames draw it at both orientations
 * (WEB-05.5 `tablet/sharing-portrait.html` and `sharing-landscape.html`, Q14; WEB-12a R6).
 *
 * Everything it reads, edits and sends belongs to ONE target, the `(identity, resource)` it was opened on (WEB-12a R1): another
 * `resourceId` is another editor (a fresh read, draft and attempt), and an answer for the previous resource never lands in it. The in-dialog
 * sync control keeps the unsaved draft, with the version it was composed against and its uncertain attempt, and reopening the editor on
 * the same resource shows it again (ia.md §1.3.3; R5); Cancel, Escape, the close icon and Close discard it, whether or not the read has
 * landed (WEB-12a review 2, R5), and so does Reload (the abandoned draft never comes back, even if the new read fails).
 *
 * Household names, members and the households you can add come from the editor's own membership read (`GET /households`, read at open
 * and again on reconnect, with its own loading, failure and Try again: WEB-12a R11, design assessment DA-M1). Until a read has answered,
 * nothing says you are in no household or not in a granted one; re-reading it never touches the draft.
 */
export interface ResourcePolicyEditorProps {
  resourceId: ResourceId;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** After a confirmed save: the receipt's revision. The editor closes itself unless this returns `false`. */
  onSaved?(result: { revision: number }): boolean | undefined;
  /**
   * Each read of the policy that answered: the policy and version the server holds (never the draft being edited, never a receipt's
   * revision). A host that shows the resource's audience itself learns it here (WEB-11a review 23, R23.1).
   */
  onPolicyRead?(read: PolicyState): void;
}

export function ResourcePolicyEditor(props: ResourcePolicyEditorProps) {
  if (!props.open) return null;
  return (
    <SharingBoundary>
      <PolicyEditorFor {...props} />
    </SharingBoundary>
  );
}

/**
 * Revision 37 (WEB-14a R40): a screen that opens the policy editor in place (the task detail) restores a draft the page before an update
 * left for `resourceId`, by opening the editor on it (`onOpen`); the editor's route opens itself. Renders nothing.
 */
export function PolicyEditorRecoveryHost({
  identity,
  resourceId,
  onOpen,
}: {
  identity: string;
  resourceId: ResourceId;
  onOpen(resourceId: ResourceId): void;
}) {
  useRecoveryHost({
    identity,
    context: policyFormContext(resourceId),
    open: () => onOpen(resourceId),
  });
  return null;
}

/** One editor per displayed identity and resource: changing either starts a new one, with nothing carried over (R1). */
function PolicyEditorFor(props: ResourcePolicyEditorProps) {
  const env = useSharingEnv();
  return (
    <PolicyEditorDialog
      key={`${env.identity}\u0000${props.resourceId}`}
      {...props}
    />
  );
}

/** The draft being edited: the policy, and the policy version it was composed against (what Save's `expected_version` is). */
type Draft = PolicyDraftState & { base: number };

/** What the sync control keeps of an unsaved draft (R5): restored only for the same identity and resource. */
interface RetainedPolicy {
  draft: Draft;
  attempt: Attempt | null;
  outcome: Outcome;
  learnt: Array<[string, string]>;
}

type Outcome =
  | null
  | { kind: "conflict"; requestId?: string }
  | { kind: "operation_conflict"; requestId?: string }
  | { kind: "uncertain"; requestId?: string }
  | { kind: "not_sent" }
  | { kind: "offline" }
  | { kind: "refused"; message?: string; requestId?: string };

function PolicyEditorDialog({
  resourceId,
  onOpenChange,
  onSaved,
  onPolicyRead,
}: ResourcePolicyEditorProps) {
  const env = useSharingEnv();
  const announcer = useAnnouncer();
  // The resource and the parent it names as ONE read saw them (WEB-11a review 16, DA16-S1). A resource under a parent (a person's field)
  // is shown only while that same read holds the parent: a parent read separately may answer for an earlier commit than the resource,
  // and PPL-5 hides a field whose person is not visible. Until then nothing of it is named, read or offered, here or at its deep link.
  const cached = useMergedUnder(resourceId);
  const read = cached.status === "ready" ? cached.value : null;
  const resource = read?.resource.merged ?? null;
  const parentId = resource?.parent_id ?? null;
  const merged =
    resource !== null && (parentId === null || read?.parent?.base)
      ? resource
      : null;
  const parentLabel =
    parentId === null ? null : (read?.parent?.merged?.label ?? null);
  const queue = useDraftQueue();
  const waiting =
    queue.status === "ready"
      ? queue.value.rows.filter(
          (draft) =>
            (draft.status === "queued" || draft.status === "in_flight") &&
            draft.index_targets.includes(resourceId),
        ).length
      : 0;

  const reading = env.online && merged !== null;
  const [policyLoad, reloadPolicy] = useSharingLoad(
    () => env.api.readPolicy(resourceId),
    { enabled: reading, now: env.now, target: [env.api, resourceId] },
  );
  const [membership, retryMembership] = useMembership({
    enabled: reading,
    read: () => env.api.readHouseholds(),
    now: env.now,
    target: [env.api],
  });
  const known = knownMembership(membership);

  const retainedAs = `policy:${resourceId}`;
  // This resource's editor session: what the sync control kept for it, and what a dismissal discards (R5).
  const [session] = useState(() => retainedSession(env.identity, retainedAs));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [learnt, setLearnt] = useState<Array<[string, string]>>([]);
  // A draft kept by the sync control when this editor was last open on this resource, until the first read lands.
  const restore = useRef<RetainedPolicy | undefined>(
    session.retained<RetainedPolicy>(retainedAs),
  );
  const [restored, setRestored] = useState(false);
  // Revision 37 (WEB-14a R40): the draft is recoverable around an app-update reload (Q4), with the version it was composed against.
  const touched = useRef(false);
  /** The draft waiting for the first read is a recovery copy (the model holds it already), not one the sync control kept. */
  const fromCopy = useRef(false);
  const loaded = useRef(false);
  loaded.current = policyLoad.status === "ready";
  const recovery = useRecoverableEditor<{ policy: Policy; base: number }>({
    identity: env.identity,
    context: policyFormContext(resourceId),
    encode: encodePolicyDraft,
    decode: decodePolicyDraft,
    start: () => ({ policy: emptyPolicy(), base: -1 }),
    untouched: () => !touched.current,
    restored: ({ policy, base }) => {
      const kept: RetainedPolicy = {
        draft: { policy, refused: null, base },
        attempt: null,
        outcome: null,
        learnt: [],
      };
      // Before the first read: shown when it lands, as a draft the sync control kept is. After it: shown now. Never sent.
      if (!loaded.current) {
        restore.current = kept;
        fromCopy.current = true;
        return;
      }
      setDraft(kept.draft);
      uncertain.current = null;
      setOutcome(null);
      setRestored(true);
    },
    // "Discard instead" (revision 38, R40-A): the draft is the policy as read now, at the gesture, never when the copies' removal completes.
    baseline: () =>
      loaded.current && policyLoad.status === "ready"
        ? { policy: policyLoad.value.policy, base: policyLoad.value.version }
        : { policy: emptyPolicy(), base: -1 },
    reset: ({ policy, base }) => {
      touched.current = false;
      if (!loaded.current) {
        // Before the first read: a copy waiting for it is not shown when it lands.
        if (fromCopy.current) restore.current = undefined;
        fromCopy.current = false;
        return;
      }
      setDraft({ policy, refused: null, base });
      setRestored(false);
    },
  });
  const [view, setView] = useState<"edit" | "grant" | "exclude">("edit");
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);
  // Held synchronously while a save is being sent: a second click or a Try again cannot send it twice at once.
  const sending = useRef(false);
  // WEB-14a revision 51 (F-R51-1): the restored policy, and "Discard instead", focus its first grant (that grant's chosen access), or the
  // grants' first control for a policy with none ("Add account grant"), read from the committed DOM at each attempt, since a reset can
  // insert or remove grants.
  const grants = useRef<HTMLDivElement>(null);
  const grantsFocus = () =>
    grants.current?.querySelector<HTMLElement>(
      '[data-grant] [role="radio"][data-state="checked"]',
    ) ?? firstControl(grants.current);
  const uncertain = useRef<Attempt | null>(null);
  const mounted = useRef(true);
  // Set on every mount: development's replay of every effect runs this cleanup and then mounts again (WEB-11a review 23).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A (re)read of the policy is the base of the edit: the draft starts from it, and a Reload discards the local edits. The FIRST read
  // after reopening shows a draft the sync control kept instead, at the version it was composed against (Save stays guarded by it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is reset only when a new read lands (a new load object)
  useEffect(() => {
    if (policyLoad.status !== "ready") return;
    onPolicyRead?.(policyLoad.value);
    const kept = restore.current;
    restore.current = undefined;
    if (kept !== undefined) {
      // A draft the sync control kept is unsaved input of this session (R40): the read is its start, the draft an edit of it.
      if (!fromCopy.current) {
        recovery.begin({
          policy: policyLoad.value.policy,
          base: policyLoad.value.version,
        });
        recovery.edit({ policy: kept.draft.policy, base: kept.draft.base });
      }
      fromCopy.current = false;
      setDraft(kept.draft);
      setLearnt(kept.learnt);
      uncertain.current = kept.attempt;
      setOutcome(kept.outcome);
      setRestored(true);
      return;
    }
    session.forget(retainedAs);
    setRestored(false);
    setDraft({
      policy: policyLoad.value.policy,
      refused: null,
      base: policyLoad.value.version,
    });
    // A fresh read is where a new editing session of the draft starts (R40).
    touched.current = false;
    recovery.begin({
      policy: policyLoad.value.policy,
      base: policyLoad.value.version,
    });
    uncertain.current = null;
  }, [policyLoad]);

  const labels = useMemo(
    () => labelsFrom(known?.households ?? [], learnt),
    [known, learnt],
  );
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const dispatch = (action: PolicyAction) => {
    const state = latestDraft.current;
    if (state === null) return;
    const next = {
      ...reducePolicy(state, action, env.accountId),
      base: state.base,
    };
    // Refused while an update reload is prepared (R40): the draft stays what was saved.
    if (!recovery.edit({ policy: next.policy, base: next.base })) return;
    touched.current = true;
    latestDraft.current = next;
    // Any edit ends an uncertain attempt: the next save is a new attempt, which the policy version guards (D-12a-2).
    uncertain.current = null;
    setOutcome(null);
    setDraft(next);
  };

  const close = () => onOpenChange(false);
  // Cancel, Escape, the close icon and Close discard the edit, on screen or still waiting for its read; the sync control keeps it
  // (ia.md §1.3.3, §3). A read that lands afterwards finds nothing to restore.
  const discard = () => {
    restore.current = undefined;
    session.discard();
  };
  const cancel = () => {
    discard();
    close();
  };
  const keep = () => {
    if (draft === null) return;
    // The sync control keeps it (R40): the editor's unmount is not a dismissal, and an update still saves it.
    recovery.keep();
    const read = policyLoad.status === "ready" ? policyLoad.value : null;
    const edited =
      read === null ||
      draft.base !== read.version ||
      !samePolicy(draft.policy, read.policy) ||
      uncertain.current !== null;
    if (!edited) {
      session.forget(retainedAs);
      return;
    }
    session.retain(retainedAs, {
      draft,
      attempt: uncertain.current,
      outcome,
      learnt,
    } satisfies RetainedPolicy);
  };
  const title = copy.POLICY_TITLE(merged?.label || copy.POLICY_UNTITLED);

  const send = async (policy: Policy, version: number) => {
    const commands: ManagementCommand[] = [
      {
        kind: "replace_policy",
        id: resourceId,
        expected_version: version,
        policy: toWirePolicy(policy),
      },
    ];
    // Admitted at the action as well as shown on the buttons: offline, unsupported or already sending, nothing is sent and the
    // outcome on screen (an uncertain attempt's Try again) stays as it is.
    if (sending.current || !env.online || !env.writable) return;
    // Its ticket first (R40): none while an update reload is prepared.
    const ticket = recovery.submitting();
    if (ticket === null) return;
    const attempt = nextAttempt(uncertain.current, commands, env.newId);
    uncertain.current = attempt;
    const shown = outcome;
    sending.current = true;
    setBusy(true);
    setOutcome(null);
    const result: SharingResult<{ revision: number }> = await untilSent(
      () => env.api.management(JSON.parse(attempt.body), attempt.key),
      { isCurrent: () => mounted.current },
    );
    sending.current = false;
    // Only a confirmed save covers what was sent; an uncertain or refused one keeps the draft (never replayed by recovery).
    if (result.ok) void ticket.succeeded();
    else ticket.failed();
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      uncertain.current = null;
      session.forget(retainedAs);
      announcer.announce(copy.SAVED_POLICY);
      if (onSaved?.({ revision: result.value.revision }) !== false) close();
      else reloadPolicy();
      return;
    }
    settleFailure(result, shown);
  };

  const settleFailure = (failure: SharingFailure, shown: Outcome) => {
    switch (failure.kind) {
      case "uncertain":
        // The attempt is kept: Try again resends it, same key, same body.
        setOutcome({ kind: "uncertain", requestId: failure.requestId });
        return;
      case "not_sent":
        setOutcome({ kind: "not_sent" });
        return;
      case "offline":
        setOutcome({ kind: "offline" });
        return;
      case "closed":
        // The session closed the request: it was not sent this time, which proves nothing about an earlier attempt (design assessment,
        // DA-P1). The attempt is kept (above), and a Try again of an uncertain one says so again while the editor is still shown.
        if (shown?.kind === "uncertain" || shown?.kind === "not_sent")
          setOutcome(shown);
        return;
    }
    // A definite refusal ends the attempt: nothing was written.
    uncertain.current = null;
    if (failure.kind === "conflict")
      setOutcome({ kind: "conflict", requestId: failure.requestId });
    else if (failure.kind === "operation_conflict")
      setOutcome({ kind: "operation_conflict", requestId: failure.requestId });
    else if (failure.kind === "forbidden" || failure.kind === "not_found")
      reloadPolicy();
    else
      setOutcome({
        kind: "refused",
        message: failure.message,
        requestId: failure.requestId,
      });
  };

  // Reload abandons the local edit: what was kept for it goes first, so a failed read cannot bring it back.
  const reload = () => {
    restore.current = undefined;
    // The abandoned draft's recovery copies go too (R40): it never comes back after a reload either.
    void recovery.end();
    session.forget(retainedAs);
    setDraft(null);
    setRestored(false);
    setOutcome(null);
    uncertain.current = null;
    reloadPolicy();
  };

  // ---- what the dialog shows -------------------------------------------------------------------------------------------------------
  let body: React.ReactNode;
  let footer: React.ReactNode = (
    <Button variant="outline" onClick={cancel}>
      {copy.CLOSE}
    </Button>
  );
  if (cached.status === "loading")
    body = (
      <p className="text-sm text-muted-foreground">{copy.POLICY_LOADING}</p>
    );
  else if (merged === null)
    body = (
      <p className="text-sm text-foreground" data-policy-state="absent">
        {copy.POLICY_ABSENT}
      </p>
    );
  else if (!env.online && draft === null)
    body = (
      <div className="flex flex-col gap-2" data-policy-state="offline">
        <p className="text-sm font-medium text-foreground">
          {copy.OFFLINE_TITLE}
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {copy.OFFLINE_BODY}
        </p>
      </div>
    );
  else if (policyLoad.status === "failed") {
    const failure = policyLoad.failure;
    body =
      failure.kind === "forbidden" ? (
        <p className="text-sm text-foreground" data-policy-state="owner-only">
          {copy.POLICY_OWNER_ONLY}
        </p>
      ) : failure.kind === "not_found" ? (
        <p className="text-sm text-foreground" data-policy-state="gone">
          {copy.POLICY_GONE}
        </p>
      ) : failure.kind === "closed" ? null : (
        <Banner
          message={copy.POLICY_LOAD_FAILED}
          requestId={"requestId" in failure ? failure.requestId : undefined}
          action={<Button onClick={reloadPolicy}>{copy.TRY_AGAIN}</Button>}
        />
      );
  } else if (policyLoad.status !== "ready" || draft === null)
    body = (
      <p className="text-sm text-muted-foreground">{copy.POLICY_LOADING}</p>
    );
  else if (view !== "edit")
    body = (
      <DirectoryLookup
        purpose={
          view === "grant"
            ? copy.ADD_ACCOUNT.slice(2)
            : copy.ADD_EXCLUSION.slice(2)
        }
        onBack={() => setView("edit")}
        onChoose={(entry: DirectoryEntry) => {
          setLearnt((known) => [...known, [entry.id, entry.username]]);
          dispatch(
            view === "grant"
              ? { type: "add_account", id: entry.id }
              : { type: "exclude", id: entry.id },
          );
          setView("edit");
        }}
      />
    );
  else {
    const read = policyLoad.value;
    // A draft composed against another version (kept through the sync control) is an edit until it is saved or reloaded.
    const changed =
      draft.base !== read.version || !samePolicy(draft.policy, read.policy);
    const audience = effectiveAudience({
      ownerId: env.accountId,
      policy: draft.policy,
      households: known?.households ?? [],
      complete: membership.status === "ready",
      labels,
      parentLimited: parentId !== null,
    });
    const behind =
      merged.policy_version !== undefined &&
      merged.policy_version !== read.version;
    const reason = !env.online
      ? copy.SAVE_OFFLINE_REASON
      : !env.writable
        ? copy.SAVE_COMPAT_REASON
        : busy
          ? copy.SAVE_BUSY_REASON
          : !changed && outcome?.kind !== "uncertain"
            ? copy.SAVE_NO_CHANGE_REASON
            : null;
    body = (
      <div className="flex flex-col gap-4" data-policy-state="editing">
        <p className="text-xs leading-relaxed text-muted-foreground">
          <strong className="font-medium text-foreground">
            {copy.REQUIRES_CONNECTION}
          </strong>{" "}
          {copy.POLICY_ONLINE_ONLY}
        </p>
        <RecoveryNotice recovery={recovery} firstFieldRef={grantsFocus} />
        {restored ? (
          <p className="text-xs text-foreground" data-policy-restored="">
            {copy.RESTORED_UNSAVED}
          </p>
        ) : null}
        {behind ? (
          <p className="text-xs text-muted-foreground">{copy.CACHE_BEHIND}</p>
        ) : null}
        {waiting > 0 ? (
          <p className="text-xs text-foreground" data-policy-queued="">
            {copy.QUEUED_EDITS(waiting)}
          </p>
        ) : null}
        <AudienceSummary
          audience={audience}
          membersAsOf={known ? formatWhen(known.at, env.now()) : null}
          parentLabel={parentLabel}
        />
        <div ref={grants}>
          <PolicyGrantsEditor
            policy={draft.policy}
            labels={labels}
            membership={membership}
            onRetryMembership={retryMembership}
            disabled={busy}
            refused={draft.refused}
            dispatch={dispatch}
            onLookup={(purpose) => setView(purpose)}
          />
        </div>
        <OutcomeBanner
          outcome={outcome}
          onReload={reload}
          retryReason={
            !env.online
              ? copy.SAVE_OFFLINE_REASON
              : !env.writable
                ? copy.SAVE_COMPAT_REASON
                : busy
                  ? copy.SAVE_BUSY_REASON
                  : null
          }
          onRetry={() => void send(draft.policy, draft.base)}
        />
      </div>
    );
    footer = (
      <>
        <Button variant="outline" onClick={cancel}>
          {copy.CANCEL}
        </Button>
        {reason === null ? (
          <Button
            variant="default"
            data-save=""
            onClick={() => void send(draft.policy, draft.base)}
          >
            {copy.SAVE_POLICY}
          </Button>
        ) : (
          <Button variant="default" data-save="" disabled reason={reason}>
            {copy.SAVE_POLICY}
          </Button>
        )}
      </>
    );
  }

  return (
    <Dialog
      open
      onClose={close}
      onDiscard={discard}
      onRetainDraft={keep}
      title={title}
      footer={footer}
      sheetBelow="desktop"
    >
      {body}
    </Dialog>
  );
}

function OutcomeBanner({
  outcome,
  onReload,
  retryReason,
  onRetry,
}: {
  outcome: Outcome;
  onReload(): void;
  /** Why Try again cannot send now (offline, unsupported, sending), or null. */
  retryReason: string | null;
  onRetry(): void;
}) {
  const retry =
    retryReason === null ? (
      <Button onClick={onRetry}>{copy.TRY_AGAIN}</Button>
    ) : (
      <Button disabled reason={retryReason}>
        {copy.TRY_AGAIN}
      </Button>
    );
  if (outcome === null) return null;
  switch (outcome.kind) {
    case "conflict":
      return (
        <Banner
          message={copy.POLICY_CONFLICT}
          requestId={outcome.requestId}
          action={<Button onClick={onReload}>{copy.RELOAD}</Button>}
        />
      );
    case "operation_conflict":
      return (
        <Banner
          message={copy.OPERATION_CONFLICT}
          requestId={outcome.requestId}
          action={<Button onClick={onReload}>{copy.RELOAD}</Button>}
        />
      );
    case "uncertain":
      return (
        <Banner
          message={copy.UNCERTAIN}
          requestId={outcome.requestId}
          action={retry}
        />
      );
    case "not_sent":
      return <Banner message={copy.NOT_SENT} action={retry} />;
    case "offline":
      return <Banner message={copy.SAVE_OFFLINE_REASON} />;
    case "refused":
      return (
        <Banner
          message={copy.REFUSED(outcome.message)}
          requestId={outcome.requestId}
        />
      );
  }
}
