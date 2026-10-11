import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { List } from "../../components/ui/list";
import {
  type DefaultTemplate,
  TEMPLATE_KINDS,
  type TemplateKind,
  useSharingDefaults,
} from "../../data";
import {
  type DirectoryEntry,
  type ManagementCommand,
  type SharingResult,
  type TemplateScope,
  untilSent,
} from "./api";
import * as copy from "./copy";
import { DirectoryLookup } from "./DirectoryLookup";
import { SharingBoundary, useSharingEnv } from "./env";
import { knownMembership, type Membership, useMembership } from "./membership";
import { labelsFrom } from "./model/audience";
import {
  emptyPolicy,
  type PolicyAction,
  type PolicyDraftState,
  reducePolicy,
  toWirePolicy,
} from "./model/policy-draft";
import { type Attempt, canonicalBody, nextAttempt } from "./model/submission";
import {
  APPLICATION_DEFAULTS,
  describeTemplate,
  effectiveTemplate,
  KIND_LABEL,
  type Layer,
  type LayerRecord,
} from "./model/templates";
import { PolicyGrantsEditor } from "./PolicyGrantsEditor";
import { Banner, ChoiceGroup, formatWhen, useSharingLoad } from "./parts";
import { type RetainedSession, retainedSession } from "./retained";

/**
 * WF-SHARING-03, the defaults and templates editor (D+sheet). The five resource kinds as tabs; the resolution chain application → primary
 * household → personal → explicit per-record policy, highlighting the layer that ACTUALLY resolves (a template at version 0 is missing
 * and inherits the next layer, never "Private"); the primary household's layer (its managers edit it, members see it read-only) and the
 * personal layer (self-serve). Each layer saves with `set_defaults` guarded by THAT layer's stored template version (`GET
 * /defaults/templates`), never another layer's. "Inherit" sends `template: null` at the override's own version. Editing a template never
 * changes existing records.
 *
 * The RESOLVED defaults, the primary household and their summaries come from the B5 snapshot only (one record, D-12a-9): it is the
 * defaults' revision evidence, and nothing is added to it. The households an explicit template can grant, and the names of the
 * households a template being edited grants, come from the editor's own membership read (`GET /households`, WEB-12a R11): B5 names only
 * the primary household and the households the resolved defaults name, so another membership, or one only an overridden template
 * names, is absent from it. That read is separately timed, has its own loading, failure and Try again, is read again on reconnect, and
 * never resets a form. Online-only: offline at open, the last snapshot is shown read-only with its time; going offline while editing keeps the forms and their unsaved choices (Save waits for the
 * connection), so coming back online loses nothing (WEB-12a R5).
 *
 * Each layer's form belongs to ONE target (WEB-12a R1): the displayed identity, the layer, the household (for the household layer, the
 * primary household it was READ for) and the kind. The household layer is read for the primary household the snapshot names now; when
 * that changes, the earlier household's template and version are never shown or sent as the new one's (its read is dropped, and the new
 * household is read before anything can be saved). The in-dialog sync control keeps each form's unsaved choices, with the version they
 * were composed against and an uncertain attempt, and reopening shows them again (ia.md §1.3.3; R5); Done, Escape and the close icon
 * discard them. What is kept belongs to the editor's SESSION, not to the forms on screen (WEB-12a review 2, R5): a dismissal discards
 * every layer, household and kind the session kept, also while it is offline, still reading, or showing another kind. A full-bleed
 * sheet below the desktop breakpoint, like the policy editor (R6).
 */
export function DefaultsEditor({
  kind,
  onKindChange,
  onClose,
}: {
  kind: TemplateKind;
  onKindChange(kind: TemplateKind): void;
  onClose(): void;
}) {
  return (
    <SharingBoundary>
      <DefaultsDialogFor
        kind={kind}
        onKindChange={onKindChange}
        onClose={onClose}
      />
    </SharingBoundary>
  );
}

/** One editor per displayed identity: another identity starts another session, with nothing carried over (R1, R5). */
function DefaultsDialogFor(props: {
  kind: TemplateKind;
  onKindChange(kind: TemplateKind): void;
  onClose(): void;
}) {
  const env = useSharingEnv();
  return <DefaultsDialog key={env.identity} {...props} />;
}

function DefaultsDialog({
  kind,
  onKindChange,
  onClose,
}: {
  kind: TemplateKind;
  onKindChange(kind: TemplateKind): void;
  onClose(): void;
}) {
  const env = useSharingEnv();
  const defaults = useSharingDefaults();
  const ids = { tabs: useId(), panel: useId() };
  // The editor's session: what the sync control kept of every form, and what a dismissal discards (R5).
  const [session] = useState(() => retainedSession(env.identity, "defaults"));
  // Opening the editor asks for the current snapshot (its member names and the primary household).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening, and again when the page comes back online
  useEffect(() => {
    if (env.online) void defaults.refresh();
  }, [env.online]);
  const snapshot = defaults.record?.snapshot ?? null;
  // Every household you are in, for what an explicit template can grant (R11): editing metadata, never merged into the snapshot.
  const [membership, retryMembership] = useMembership({
    enabled: env.online,
    read: () => env.api.readHouseholds(),
    now: env.now,
    target: [env.api],
  });
  const primaryId = snapshot?.defaults.primary_household_id ?? null;
  const primary =
    snapshot?.households.find((household) => household.id === primaryId) ??
    null;
  const [personalLoad, reloadPersonal] = useSharingLoad(
    () => env.api.readTemplates(null),
    { enabled: env.online, now: env.now, target: [env.api] },
  );
  // Bound to the primary household it is read for (R1): another primary household is another read.
  const [householdLoad, reloadHousehold] = useSharingLoad(
    () => env.api.readTemplates(primaryId),
    {
      enabled: env.online && primaryId !== null,
      now: env.now,
      target: [env.api, primaryId],
    },
  );
  const personal: LayerRecord | null =
    personalLoad.status === "ready" ? personalLoad.value[kind] : null;
  const household: LayerRecord | null =
    householdLoad.status === "ready" ? householdLoad.value[kind] : null;
  const resolved = effectiveTemplate({
    kind,
    personal,
    household,
    primaryHouseholdId: primaryId,
  });
  // A summary names only the primary household, which B5 always lists: summaries describe B5's resolved defaults and their layers.
  const resolvedHouseholds = snapshot?.households ?? [];
  const describe = (template: DefaultTemplate) =>
    describeTemplate(template, primaryId, resolvedHouseholds).summary;
  // What the personal layer inherits: the household's template when it has one, else the application's.
  const nextLayer = effectiveTemplate({
    kind,
    personal: null,
    household,
    primaryHouseholdId: primaryId,
  });

  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, at: number) => {
    const last = TEMPLATE_KINDS.length - 1;
    const to =
      event.key === "ArrowRight"
        ? at === last
          ? 0
          : at + 1
        : event.key === "ArrowLeft"
          ? at === 0
            ? last
            : at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (to === null) return;
    event.preventDefault();
    onKindChange(TEMPLATE_KINDS[to] as TemplateKind);
    tabs.current[to]?.focus();
  };

  // After a save the snapshot is read again by a request issued AFTER it (R7): one already under way may predate the change.
  const saved = (layer: "personal" | "household") => {
    if (layer === "personal") reloadPersonal();
    else reloadHousehold();
    void defaults.acquire(defaults.boundary());
  };

  // The open forms, so the sync control can keep what they show (ia.md §1.3.3, §3; R5). A discard is the session's, not theirs.
  const forms = useRef(new Map<string, FormKeeper>());
  const register = (id: string, keeper: FormKeeper) => {
    forms.current.set(id, keeper);
    return () => {
      if (forms.current.get(id) === keeper) forms.current.delete(id);
    };
  };
  const discardForms = () => session.discard();
  const done = () => {
    discardForms();
    onClose();
  };
  // Offline at open, nothing was read: the last snapshot, read-only. Gone offline after the forms were read: they stay.
  const formsRead = personalLoad.status === "ready";

  return (
    <Dialog
      open
      onClose={onClose}
      onDiscard={discardForms}
      onRetainDraft={() => {
        for (const keeper of forms.current.values()) keeper.keep();
      }}
      title={copy.DEFAULTS_TITLE(KIND_LABEL[kind])}
      initialFocusSelector='[role="tab"][aria-selected="true"]'
      sheetBelow="desktop"
      footer={
        <Button variant="secondary" onClick={done}>
          {copy.CLOSE}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[12.5px] leading-[1.55] text-ink-2">
          <strong className="font-medium text-ink-1">
            {copy.REQUIRES_CONNECTION}
          </strong>{" "}
          {copy.DEFAULTS_ONLINE_ONLY}
        </p>
        <div
          role="tablist"
          aria-label={copy.KINDS_LABEL}
          id={ids.tabs}
          className="flex flex-wrap gap-1"
        >
          {TEMPLATE_KINDS.map((each, at) => (
            <button
              key={each}
              ref={(node) => {
                tabs.current[at] = node;
              }}
              type="button"
              role="tab"
              id={`${ids.tabs}-${each}`}
              aria-selected={each === kind}
              aria-controls={ids.panel}
              tabIndex={each === kind ? 0 : -1}
              onClick={() => onKindChange(each)}
              onKeyDown={(event) => onTabKey(event, at)}
              className="atlas-transition min-h-11 rounded-control border border-hairline-strong px-3 text-[13px] text-ink-1 aria-selected:border-action-fill aria-selected:font-medium"
            >
              {KIND_LABEL[each]}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={ids.panel}
          aria-labelledby={`${ids.tabs}-${kind}`}
          className="flex flex-col gap-5"
        >
          <Chain
            resolves={personalLoad.status === "ready" ? resolved.layer : null}
            householdName={primary?.name ?? null}
          />
          {!env.online && !formsRead ? (
            <OfflineDefaults
              kind={kind}
              template={snapshot?.defaults[kind] ?? null}
              describe={describe}
              at={defaults.record?.fetched_at ?? null}
              now={env.now()}
            />
          ) : (
            <>
              {!env.online ? (
                <p
                  className="text-[12.5px] text-ink-1"
                  data-defaults-offline-editing=""
                >
                  {copy.DEFAULTS_OFFLINE_EDITING}
                </p>
              ) : null}
              <section className="flex flex-col gap-2" data-layer="household">
                {primaryId === null ? (
                  <p className="text-[13px] text-ink-2">{copy.NO_PRIMARY}</p>
                ) : (
                  <>
                    <h3 className="text-[13.5px] font-medium text-ink-1">
                      {copy.HOUSEHOLD_LAYER(primary?.name ?? "")}
                    </h3>
                    {householdLoad.status === "failed" ? (
                      <Banner
                        message={copy.TEMPLATES_LOAD_FAILED}
                        requestId={
                          "requestId" in householdLoad.failure
                            ? householdLoad.failure.requestId
                            : undefined
                        }
                        action={
                          <Button onClick={reloadHousehold}>
                            {copy.TRY_AGAIN}
                          </Button>
                        }
                      />
                    ) : household === null ? (
                      <p className="text-[13px] text-ink-2">…</p>
                    ) : (
                      <>
                        <p className="text-[13px] text-ink-1">
                          {copy.HOUSEHOLD_CURRENT(
                            describe(
                              household.template ?? APPLICATION_DEFAULTS[kind],
                            ),
                            household.version,
                          )}
                        </p>
                        {primary?.role === "manager" ? (
                          <LayerForm
                            key={`household:${primaryId}:${kind}:${household.version}:${householdLoad.status === "ready" ? householdLoad.at : 0}`}
                            kind={kind}
                            layer="household"
                            householdId={primaryId}
                            session={session}
                            register={register}
                            record={household}
                            label={copy.HOUSEHOLD_EDIT_LABEL(
                              primary.name,
                              KIND_LABEL[kind],
                            )}
                            inheritLabel={copy.CHOICE_INHERIT_HOUSEHOLD}
                            membership={membership}
                            onRetryMembership={retryMembership}
                            describe={describe}
                            onSaved={() => saved("household")}
                          />
                        ) : (
                          <p className="text-[12.5px] text-ink-2">
                            {copy.HOUSEHOLD_MANAGER_ONLY}
                          </p>
                        )}
                      </>
                    )}
                  </>
                )}
              </section>
              <section className="flex flex-col gap-2" data-layer="personal">
                <h3 className="flex items-center gap-2 text-[13.5px] font-medium text-ink-1">
                  {copy.PERSONAL_LAYER}
                  <span className="text-[12px] font-normal text-ink-2">
                    {copy.PERSONAL_SELF_SERVE}
                  </span>
                </h3>
                {personalLoad.status === "failed" ? (
                  <Banner
                    message={copy.TEMPLATES_LOAD_FAILED}
                    requestId={
                      "requestId" in personalLoad.failure
                        ? personalLoad.failure.requestId
                        : undefined
                    }
                    action={
                      <Button onClick={reloadPersonal}>{copy.TRY_AGAIN}</Button>
                    }
                  />
                ) : personal === null ? (
                  <p className="text-[13px] text-ink-2">…</p>
                ) : (
                  <>
                    <p
                      className="text-[13px] text-ink-1"
                      data-personal-state=""
                    >
                      {resolved.layer === "personal"
                        ? copy.PERSONAL_OVERRIDE(
                            describe(resolved.template),
                            personal.version,
                          )
                        : copy.PERSONAL_INHERITS(
                            describe(nextLayer.template),
                            personal.version,
                          )}
                    </p>
                    <LayerForm
                      key={`personal:${kind}:${personal.version}:${personalLoad.status === "ready" ? personalLoad.at : 0}`}
                      kind={kind}
                      layer="personal"
                      householdId={null}
                      session={session}
                      register={register}
                      record={personal}
                      label={copy.PERSONAL_EDIT_LABEL(KIND_LABEL[kind])}
                      inheritLabel={copy.CHOICE_INHERIT_PERSONAL(
                        describe(nextLayer.template),
                      )}
                      membership={membership}
                      onRetryMembership={retryMembership}
                      describe={describe}
                      onSaved={() => saved("personal")}
                    />
                  </>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function Chain({
  resolves,
  householdName,
}: {
  resolves: Layer | null;
  householdName: string | null;
}) {
  const steps: Array<{ layer: Layer | "explicit"; label: string }> = [
    { layer: "application", label: copy.CHAIN_APPLICATION },
    { layer: "household", label: copy.CHAIN_HOUSEHOLD(householdName) },
    { layer: "personal", label: copy.CHAIN_PERSONAL },
    { layer: "explicit", label: copy.CHAIN_EXPLICIT },
  ];
  return (
    <List className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
      {steps.map((step, at) => (
        <li
          key={step.layer}
          data-chain={step.layer}
          aria-current={step.layer === resolves ? "true" : undefined}
          className={`list-none rounded-badge border px-2 py-1 ${
            step.layer === resolves
              ? "border-action-fill font-medium text-ink-1"
              : "border-hairline-strong text-ink-2"
          }`}
        >
          {at > 0 ? <span aria-hidden="true">→ </span> : null}
          {step.label}
          {step.layer === resolves ? ` (${copy.CHAIN_RESOLVES})` : null}
        </li>
      ))}
    </List>
  );
}

function OfflineDefaults({
  kind,
  template,
  describe,
  at,
  now,
}: {
  kind: TemplateKind;
  template: DefaultTemplate | null;
  describe(template: DefaultTemplate): string;
  at: number | null;
  now: number;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-defaults-offline="">
      <p className="text-[13px] text-ink-1">{copy.DEFAULTS_OFFLINE_READONLY}</p>
      {template === null ? (
        <p className="text-[13px] text-ink-2">{copy.DEFAULTS_NONE_YET}</p>
      ) : (
        <p className="text-[13.5px] text-ink-1">
          {KIND_LABEL[kind]}: {describe(template)}
        </p>
      )}
      {at !== null ? (
        <p className="text-[12px] text-ink-2">
          {copy.AS_OF(formatWhen(at, now))}
        </p>
      ) : null}
    </div>
  );
}

// ---- one layer's form -----------------------------------------------------------------------------------------------------------------
type ChoiceValue = "inherit" | "private" | "read" | "edit" | "explicit";

const choiceOf = (record: LayerRecord): ChoiceValue => {
  const template = record.version > 0 ? record.template : null;
  if (template === null) return "inherit";
  if (template.kind === "private") return "private";
  if (template.kind === "primary_household")
    return template.edit ? "edit" : "read";
  return "explicit";
};

type Outcome =
  | null
  | { kind: "conflict"; requestId?: string }
  | { kind: "uncertain"; requestId?: string }
  | { kind: "not_sent" }
  | { kind: "refused"; message?: string; requestId?: string };

/** What the dialog asks of an open form: keep its unsaved choices (the sync control). */
interface FormKeeper {
  keep(): void;
}

/** What the sync control keeps of one form (R5): restored only for the same identity, layer, household and kind. */
interface RetainedForm {
  choice: ChoiceValue;
  explicit: PolicyDraftState;
  learnt: Array<[string, string]>;
  /** The layer's template version the choices were composed against: Save's `expected_version`. */
  base: number;
  attempt: Attempt | null;
  outcome: Outcome;
}

function LayerForm({
  kind,
  layer,
  householdId,
  session,
  register,
  record,
  label,
  inheritLabel,
  membership,
  onRetryMembership,
  describe,
  onSaved,
}: {
  kind: TemplateKind;
  layer: "personal" | "household";
  householdId: string | null;
  session: RetainedSession;
  register(id: string, keeper: FormKeeper): () => void;
  record: LayerRecord;
  label: string;
  inheritLabel: string;
  /** Your households (the complete membership list): what an explicit template can grant, and the granted households' names. */
  membership: Membership;
  onRetryMembership(): void;
  describe(template: DefaultTemplate): string;
  onSaved(): void;
}) {
  const env = useSharingEnv();
  const announcer = useAnnouncer();
  // This form's target: one layer of one kind, for the household it was read for (R1), under the displayed identity.
  const target = `defaults:${layer}:${householdId ?? "personal"}:${kind}`;
  const [kept] = useState(() => session.retained<RetainedForm>(target));
  const [choice, setChoice] = useState<ChoiceValue>(
    () => kept?.choice ?? choiceOf(record),
  );
  const [explicit, setExplicit] = useState<PolicyDraftState>(
    () =>
      kept?.explicit ?? {
        policy:
          record.template?.kind === "explicit"
            ? record.template.policy
            : emptyPolicy(),
        refused: null,
      },
  );
  const [learnt, setLearnt] = useState<Array<[string, string]>>(
    () => kept?.learnt ?? [],
  );
  const [lookup, setLookup] = useState<"grant" | "exclude" | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(() => kept?.outcome ?? null);
  const [busy, setBusy] = useState(false);
  // Held synchronously while a save is being sent: a second click or a Try again cannot send it twice at once.
  const sending = useRef(false);
  // The version these choices were composed against: the record's, or the one a kept draft was composed against.
  const base = kept?.base ?? record.version;
  const uncertain = useRef<Attempt | null>(kept?.attempt ?? null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const chosen: DefaultTemplate | null =
    choice === "inherit"
      ? null
      : choice === "private"
        ? { kind: "private" }
        : choice === "read" || choice === "edit"
          ? { kind: "primary_household", edit: choice === "edit" }
          : { kind: "explicit", policy: toWirePolicy(explicit.policy) };
  const stored = record.version > 0 ? record.template : null;
  const normalise = (template: DefaultTemplate | null) =>
    template?.kind === "explicit"
      ? { kind: "explicit", policy: toWirePolicy(template.policy) }
      : template;
  const changed =
    base !== record.version ||
    canonicalBody(normalise(chosen)) !== canonicalBody(normalise(stored));

  // The sync control keeps what is on screen (the dialog asks every open form); a discard is the session's.
  const latest = useRef<RetainedForm | null>(null);
  latest.current =
    changed || uncertain.current !== null
      ? {
          choice,
          explicit,
          learnt,
          base,
          attempt: uncertain.current,
          outcome,
        }
      : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: registered once per form; it reads the latest choices through a ref
  useEffect(
    () =>
      register(target, {
        keep: () => {
          if (latest.current === null) session.forget(target);
          else session.retain(target, latest.current);
        },
      }),
    [],
  );

  const edited = () => {
    uncertain.current = null;
    setOutcome(null);
  };
  const dispatch = (action: PolicyAction) => {
    edited();
    setExplicit((state) => reducePolicy(state, action, env.accountId));
  };

  const send = async () => {
    const commands: ManagementCommand[] = [
      {
        kind: "set_defaults",
        household_id: householdId,
        resource_kind: kind,
        // THIS layer's stored template version (or the one kept choices were composed against): a stale one is refused, never
        // overwritten (WF-SHARING-03 Er).
        expected_version: base,
        template: chosen,
      },
    ];
    // Admitted at the action as well as shown on the buttons: offline, unsupported or already sending, nothing is sent and the
    // outcome on screen (an uncertain attempt's Try again) stays as it is.
    if (sending.current || !env.online || !env.writable) return;
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
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      uncertain.current = null;
      session.forget(target);
      announcer.announce(copy.SAVED_DEFAULTS);
      onSaved();
      return;
    }
    switch (result.kind) {
      case "uncertain":
        setOutcome({ kind: "uncertain", requestId: result.requestId });
        return;
      case "not_sent":
        setOutcome({ kind: "not_sent" });
        return;
      case "offline":
      case "closed":
        // Not sent this time: a Try again of an uncertain attempt keeps it, and says so again (the attempt itself is kept above).
        if (shown?.kind === "uncertain" || shown?.kind === "not_sent")
          setOutcome(shown);
        return;
      case "conflict":
        uncertain.current = null;
        setOutcome({ kind: "conflict", requestId: result.requestId });
        return;
      default:
        uncertain.current = null;
        setOutcome({
          kind: "refused",
          message: result.message,
          requestId: result.requestId,
        });
    }
  };

  if (lookup !== null)
    return (
      <DirectoryLookup
        purpose={
          lookup === "grant"
            ? copy.ADD_ACCOUNT.slice(2)
            : copy.ADD_EXCLUSION.slice(2)
        }
        onBack={() => setLookup(null)}
        onChoose={(entry: DirectoryEntry) => {
          setLearnt((known) => [...known, [entry.id, entry.username]]);
          dispatch(
            lookup === "grant"
              ? { type: "add_account", id: entry.id }
              : { type: "exclude", id: entry.id },
          );
          setLookup(null);
        }}
      />
    );

  const reason = !env.online
    ? copy.SAVE_OFFLINE_REASON
    : !env.writable
      ? copy.SAVE_COMPAT_REASON
      : busy
        ? copy.SAVE_BUSY_REASON
        : !changed && outcome?.kind !== "uncertain"
          ? copy.SAVE_NO_CHANGE_REASON
          : null;
  const retryReason = !env.online
    ? copy.SAVE_OFFLINE_REASON
    : !env.writable
      ? copy.SAVE_COMPAT_REASON
      : busy
        ? copy.SAVE_BUSY_REASON
        : null;
  const retry =
    retryReason === null ? (
      <Button onClick={() => void send()}>{copy.TRY_AGAIN}</Button>
    ) : (
      <Button disabled reason={retryReason}>
        {copy.TRY_AGAIN}
      </Button>
    );
  const household = layer === "household";
  return (
    <div className="flex flex-col gap-3" data-layer-form={layer}>
      {kept !== undefined ? (
        <p className="text-[12.5px] text-ink-1" data-layer-restored="">
          {copy.RESTORED_UNSAVED}
        </p>
      ) : null}
      <ChoiceGroup<ChoiceValue>
        label={label}
        value={choice}
        orientation="vertical"
        disabled={busy}
        onChange={(next) => {
          edited();
          setChoice(next);
        }}
        choices={
          household
            ? [
                { value: "private", label: copy.CHOICE_PRIVATE },
                { value: "read", label: copy.CHOICE_HOUSEHOLD_READ },
                { value: "edit", label: copy.CHOICE_HOUSEHOLD_EDIT },
                { value: "explicit", label: copy.CHOICE_EXPLICIT },
                { value: "inherit", label: inheritLabel },
              ]
            : [
                { value: "inherit", label: inheritLabel },
                { value: "private", label: copy.CHOICE_PRIVATE },
                { value: "read", label: copy.CHOICE_PRIMARY_READ },
                { value: "edit", label: copy.CHOICE_PRIMARY_EDIT },
                { value: "explicit", label: copy.CHOICE_EXPLICIT },
              ]
        }
      />
      {choice === "explicit" ? (
        <PolicyGrantsEditor
          policy={explicit.policy}
          labels={labelsFrom(
            knownMembership(membership)?.households ?? [],
            learnt,
          )}
          membership={membership}
          onRetryMembership={onRetryMembership}
          disabled={busy}
          refused={explicit.refused}
          dispatch={dispatch}
          onLookup={(purpose) => setLookup(purpose)}
        />
      ) : null}
      <p className="text-[12.5px] leading-[1.55] text-ink-2" data-preview="">
        {changed
          ? copy.PREVIEW_CHANGE(
              chosen === null ? inheritLabel : describe(chosen),
            )
          : copy.PREVIEW_UNCHANGED}
      </p>
      {outcome?.kind === "conflict" ? (
        <Banner
          message={copy.TEMPLATE_CONFLICT}
          requestId={outcome.requestId}
          action={
            <Button
              onClick={() => {
                session.forget(target);
                onSaved();
              }}
            >
              {copy.RELOAD}
            </Button>
          }
        />
      ) : outcome?.kind === "uncertain" ? (
        <Banner
          message={copy.UNCERTAIN}
          requestId={outcome.requestId}
          action={retry}
        />
      ) : outcome?.kind === "not_sent" ? (
        <Banner message={copy.NOT_SENT} action={retry} />
      ) : outcome?.kind === "refused" ? (
        <Banner
          message={copy.REFUSED(outcome.message)}
          requestId={outcome.requestId}
        />
      ) : null}
      <span>
        {reason === null ? (
          <Button
            variant="primary"
            data-save={layer}
            onClick={() => void send()}
          >
            {copy.SAVE_DEFAULTS}
          </Button>
        ) : (
          <Button variant="primary" data-save={layer} disabled reason={reason}>
            {copy.SAVE_DEFAULTS}
          </Button>
        )}
      </span>
    </div>
  );
}

export type { TemplateScope };
