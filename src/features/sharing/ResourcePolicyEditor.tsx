import { useEffect, useMemo, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import {
  type Policy,
  type ResourceId,
  type SnapshotHousehold,
  useCachedResource,
  useDraftQueue,
} from "../../data";
import { AudienceSummary } from "./AudienceSummary";
import {
  type DirectoryEntry,
  type ManagementCommand,
  type SharingFailure,
  type SharingResult,
  untilSent,
} from "./api";
import * as copy from "./copy";
import { DirectoryLookup } from "./DirectoryLookup";
import { SharingBoundary, useSharingEnv } from "./env";
import { effectiveAudience, labelsFrom } from "./model/audience";
import {
  type PolicyAction,
  type PolicyDraftState,
  reducePolicy,
  samePolicy,
  toWirePolicy,
} from "./model/policy-draft";
import { type Attempt, nextAttempt } from "./model/submission";
import { PolicyGrantsEditor } from "./PolicyGrantsEditor";
import { Banner, formatWhen, useSharingLoad } from "./parts";

/**
 * WF-SHARING-04, the resource policy editor: a STANDALONE, resource-kind-agnostic component (WEB-12a's public interface). It opens on any
 * resource the cache holds, shows its effective visibility as edited, and replaces its policy with `replace_policy`, guarded by the policy
 * version read from `GET /policies/{id}` when it opened (D-12a-3). Online-only (D-12a-1): nothing about a policy is stored on the device,
 * nothing is queued, and Save is disabled while offline with the reason beside it. Nothing here knows what kind of resource it is.
 *
 * A dialog on desktop; below the tablet breakpoint the shared dialog is a full-bleed sheet (ia.md §3).
 */
export interface ResourcePolicyEditorProps {
  resourceId: ResourceId;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** After a confirmed save: the receipt's revision. The editor closes itself unless this returns `false`. */
  onSaved?(result: { revision: number }): boolean | undefined;
}

export function ResourcePolicyEditor(props: ResourcePolicyEditorProps) {
  if (!props.open) return null;
  return (
    <SharingBoundary>
      <PolicyEditorDialog {...props} />
    </SharingBoundary>
  );
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
}: ResourcePolicyEditorProps) {
  const env = useSharingEnv();
  const announcer = useAnnouncer();
  const cached = useCachedResource(resourceId);
  const merged = cached.status === "ready" ? cached.value.merged : null;
  const parentId = merged?.parent_id ?? null;
  const parent = useCachedResource(parentId ?? "");
  const parentLabel =
    parentId !== null && parent.status === "ready"
      ? (parent.value.merged?.label ?? null)
      : null;
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
    { enabled: reading, now: env.now },
  );
  const [householdsLoad] = useSharingLoad(() => env.api.readHouseholds(), {
    enabled: reading,
    now: env.now,
  });
  const households: SnapshotHousehold[] =
    householdsLoad.status === "ready" ? householdsLoad.value : [];

  const [draft, setDraft] = useState<PolicyDraftState | null>(null);
  const [learnt, setLearnt] = useState<Array<[string, string]>>([]);
  const [view, setView] = useState<"edit" | "grant" | "exclude">("edit");
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);
  const uncertain = useRef<Attempt | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  // A (re)read of the policy is the base of the edit: the draft starts from it, and a Reload discards the local edits.
  const loadedAt = policyLoad.status === "ready" ? policyLoad.at : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is reset only when a new read lands
  useEffect(() => {
    if (policyLoad.status !== "ready") return;
    setDraft({ policy: policyLoad.value.policy, refused: null });
    uncertain.current = null;
  }, [loadedAt]);

  const labels = useMemo(
    () => labelsFrom(households, learnt),
    [households, learnt],
  );
  const dispatch = (action: PolicyAction) => {
    // Any edit ends an uncertain attempt: the next save is a new attempt, which the policy version guards (D-12a-2).
    uncertain.current = null;
    setOutcome(null);
    setDraft((state) =>
      state === null ? state : reducePolicy(state, action, env.accountId),
    );
  };

  const close = () => onOpenChange(false);
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
    const attempt = nextAttempt(uncertain.current, commands, env.newId);
    uncertain.current = attempt;
    setBusy(true);
    setOutcome(null);
    const result: SharingResult<{ revision: number }> = await untilSent(
      () => env.api.management(JSON.parse(attempt.body), attempt.key),
      { isCurrent: () => mounted.current },
    );
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      uncertain.current = null;
      announcer.announce(copy.SAVED_POLICY);
      if (onSaved?.({ revision: result.value.revision }) !== false) close();
      else reloadPolicy();
      return;
    }
    settleFailure(result);
  };

  const settleFailure = (failure: SharingFailure) => {
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
        // The session closed the request: the gate has taken over, nothing to show.
        uncertain.current = null;
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

  // ---- what the dialog shows -------------------------------------------------------------------------------------------------------
  let body: React.ReactNode;
  let footer: React.ReactNode = (
    <Button variant="secondary" onClick={close}>
      {copy.CLOSE}
    </Button>
  );
  if (cached.status === "loading")
    body = <p className="text-[13px] text-ink-2">{copy.POLICY_LOADING}</p>;
  else if (merged === null)
    body = (
      <p className="text-[13.5px] text-ink-1" data-policy-state="absent">
        {copy.POLICY_ABSENT}
      </p>
    );
  else if (!env.online && draft === null)
    body = (
      <div className="flex flex-col gap-2" data-policy-state="offline">
        <p className="text-[14px] font-medium text-ink-1">
          {copy.OFFLINE_TITLE}
        </p>
        <p className="text-[13px] leading-[1.55] text-ink-2">
          {copy.OFFLINE_BODY}
        </p>
      </div>
    );
  else if (policyLoad.status === "failed") {
    const failure = policyLoad.failure;
    body =
      failure.kind === "forbidden" ? (
        <p className="text-[13.5px] text-ink-1" data-policy-state="owner-only">
          {copy.POLICY_OWNER_ONLY}
        </p>
      ) : failure.kind === "not_found" ? (
        <p className="text-[13.5px] text-ink-1" data-policy-state="gone">
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
    body = <p className="text-[13px] text-ink-2">{copy.POLICY_LOADING}</p>;
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
    const changed = !samePolicy(draft.policy, read.policy);
    const audience = effectiveAudience({
      ownerId: env.accountId,
      policy: draft.policy,
      households,
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
        <p className="text-[12.5px] leading-[1.55] text-ink-2">
          <strong className="font-medium text-ink-1">
            {copy.REQUIRES_CONNECTION}
          </strong>{" "}
          {copy.POLICY_ONLINE_ONLY}
        </p>
        {behind ? (
          <p className="text-[12.5px] text-ink-2">{copy.CACHE_BEHIND}</p>
        ) : null}
        {waiting > 0 ? (
          <p className="text-[12.5px] text-ink-1" data-policy-queued="">
            {copy.QUEUED_EDITS(waiting)}
          </p>
        ) : null}
        <AudienceSummary
          audience={audience}
          membersAsOf={
            householdsLoad.status === "ready"
              ? formatWhen(householdsLoad.at, env.now())
              : null
          }
          parentLabel={parentLabel}
        />
        <PolicyGrantsEditor
          policy={draft.policy}
          labels={labels}
          households={households}
          disabled={busy}
          refused={draft.refused}
          dispatch={dispatch}
          onLookup={(purpose) => setView(purpose)}
        />
        <OutcomeBanner
          outcome={outcome}
          onReload={() => {
            setOutcome(null);
            reloadPolicy();
          }}
          onRetry={() => void send(draft.policy, read.version)}
        />
      </div>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={close}>
          {copy.CANCEL}
        </Button>
        {reason === null ? (
          <Button
            variant="primary"
            data-save=""
            onClick={() => void send(draft.policy, read.version)}
          >
            {copy.SAVE_POLICY}
          </Button>
        ) : (
          <Button variant="primary" data-save="" disabled reason={reason}>
            {copy.SAVE_POLICY}
          </Button>
        )}
      </>
    );
  }

  return (
    <Dialog open onClose={close} title={title} footer={footer}>
      {body}
    </Dialog>
  );
}

function OutcomeBanner({
  outcome,
  onReload,
  onRetry,
}: {
  outcome: Outcome;
  onReload(): void;
  onRetry(): void;
}) {
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
          action={<Button onClick={onRetry}>{copy.TRY_AGAIN}</Button>}
        />
      );
    case "not_sent":
      return (
        <Banner
          message={copy.NOT_SENT}
          action={<Button onClick={onRetry}>{copy.TRY_AGAIN}</Button>}
        />
      );
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
