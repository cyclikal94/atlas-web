import {
  type ReactNode,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
} from "react";
import { Button } from "../../../components/ui/button";
import { type CacheRow, type Policy, useSharingDefaults } from "../../../data";
// The sharing feature's public chooser, from its own module (see `sharing/index.ts`).
import { AudienceChooser } from "../../sharing/AudienceChooser";
import type { TaskActions } from "../actions";
import type { EnrolCommand } from "../api";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { momentLabel, whoLabel } from "../format";
import {
  answerEnrolment,
  askEnrolment,
  type EnrolmentDraft as Draft,
  discardEnrolmentDraft,
  type EnrolmentAttempt,
  type EnrolmentTicket,
  editEnrolmentDraft,
  enrolmentAttemptOf,
  enrolmentDraftOf,
  enrolmentFull,
  enrolmentLock,
  forgetRefusal,
  type JointAnswer,
  noteIfRefused,
  openEnrolmentDraft,
  refusalOf,
  settleEnrolment,
  startEnrolment,
  subscribeEnrolment,
} from "../memory";
import { canonicalBody } from "../model/attempt";
import { type Enrolment, parseProgressState } from "../model/contract";
import { enrolCommand, progressDefaultPolicy } from "../model/enrolment";
import { jointLine } from "../model/row-state";
import type { RowModel } from "../view";

export const CONTROLS_COPY = {
  closureHeading: "This day",
  close: "Close without completing",
  reopen: "Reopen",
  closeNote: "Closing doesn't count as done and doesn't add to a streak.",
  exclude: "Exclude from my streak",
  undoExclude: "Undo streak exclusion",
  closed: "Closed. Not sent yet.",
  reopened: "Reopened. Not sent yet.",
  excluded: "Excluded from your streak. Not sent yet.",
  included: "Streak exclusion undone. Not sent yet.",
  noEdit: "You can't change this day",
  archive: "Archive",
  restore: "Restore",
  archiveNote: "Archiving hides this task from Today. Its history stays.",
  archived: "Archived. Not sent yet.",
  restored: "Restored. Not sent yet.",
  conflict: "Someone else already changed this — reload and try again",
  archiveConflict: "This changed since it was archived — reload and try again",
  whoHeading: "Who's on this",
  mine: "Your result",
  settings: "Your settings",
  join: "Join this task",
  leave: "Leave this task",
  consent: "Count me in the shared total",
  offline:
    "You're offline, so these can't be changed right now. Everything else on this page still works.",
  enrolFailed: "Couldn't confirm the change. Try again.",
  enrolRefused: "This change wasn't accepted. The latest settings are shown.",
  enrolUnavailable: "Your settings for this task aren't available.",
  loading: "Loading your settings",
  sending: "Sending your change…",
  confirming: "Checking your settings…",
  finishFirst: "Save or cancel the sharing change first",
  keptDraft:
    "Not saved: your settings changed after you started this change, so it can't be sent. Discard it to change the settings shown.",
  discard: "Discard this change",
  discardFirst: "Discard the unsaved change first",
  full: "Too many unsaved changes on this page: save or discard one first",
  saved: "Saved.",
  joinConsent: "Count your contribution in the shared total?",
  consentYes: "Yes, include my contribution",
  consentNo: "No, leave my contribution out of the shared total",
  chooseConsent: "Choose whether to count your contribution first",
  audienceHeading: "Who sees your progress from now on",
  audienceNote:
    "This applies to days from now on. A day already started keeps its own sharing (Who sees my progress).",
  defaultAudience: "This starts from your default sharing.",
  lastAudience: "This starts from the sharing you had before.",
  defaultLoading: "Loading your default sharing",
  defaultFailed: "Your default sharing couldn't be loaded.",
  audienceUnknown: "Who would see your progress isn't known yet",
  changeAudience: "Change…",
  saveAudience: "Save sharing",
  cancel: "Cancel",
  noChange: "Nothing has changed",
  /** Who an enrolment's policy names (no household names or members: the editor shows those). */
  audienceLine: (policy: Policy): string => {
    const households = policy.grants.filter(
      (g) => g.kind === "household",
    ).length;
    const people = policy.grants.length - households;
    const reach = [
      households > 0
        ? `${households} household${households === 1 ? "" : "s"}`
        : "",
      people > 0 ? `${people} ${people === 1 ? "person" : "people"}` : "",
    ].filter(Boolean);
    const excluded = policy.exclude_accounts.length;
    return reach.length === 0
      ? "only you"
      : `you and ${reach.join(" and ")}${excluded > 0 ? `, ${excluded} excluded` : ""}`;
  },
} as const;

/** Close/Reopen (`resolve`) and Exclude/Undo (`exclude`), Q21's closure row. No confirmation dialogs (none drawn). Both queue offline. */
export function ClosureControls({
  row,
  actions,
  writable,
}: {
  row: RowModel;
  actions: Pick<TaskActions, "resolve" | "exclude">;
  writable: boolean;
}) {
  const heading = useId();
  const note = useId();
  const { data } = row;
  const excluded = row.progress?.excluded === true;
  // Hidden entirely unless the policy allows it, the day is not covered and my stream exists (cached or pending).
  const exclusionShown =
    data.definition.allow_streak_exclusions &&
    data.covered_by === null &&
    (row.streamPresent || row.streamPending);
  const conflict =
    row.attention !== null &&
    ["resolve", "exclude"].includes(row.attention.kind);
  return (
    <section
      aria-labelledby={heading}
      className="flex flex-col gap-2"
      data-closure=""
    >
      <h2
        id={heading}
        className="text-base font-semibold tracking-tight text-foreground"
      >
        {CONTROLS_COPY.closureHeading}
      </h2>
      <div className="flex flex-wrap items-start gap-2">
        {!writable || !row.canEdit ? (
          <Button
            disabled
            reason={!writable ? copy.NOT_WRITABLE : CONTROLS_COPY.noEdit}
          >
            {data.resolved ? CONTROLS_COPY.reopen : CONTROLS_COPY.close}
          </Button>
        ) : (
          <Button
            aria-describedby={note}
            onClick={() => void actions.resolve(row, !data.resolved)}
          >
            {data.resolved ? CONTROLS_COPY.reopen : CONTROLS_COPY.close}
          </Button>
        )}
        {exclusionShown ? (
          writable ? (
            <Button onClick={() => void actions.exclude(row, !excluded)}>
              {excluded ? CONTROLS_COPY.undoExclude : CONTROLS_COPY.exclude}
            </Button>
          ) : (
            <Button disabled reason={copy.NOT_WRITABLE}>
              {excluded ? CONTROLS_COPY.undoExclude : CONTROLS_COPY.exclude}
            </Button>
          )
        ) : null}
      </div>
      <p id={note} className="text-xs text-muted-foreground">
        {CONTROLS_COPY.closeNote}
      </p>
      {conflict ? (
        <p className="text-xs text-destructive" data-closure-conflict="">
          {CONTROLS_COPY.conflict}
        </p>
      ) : null}
    </section>
  );
}

/** Archive / Restore (`archive`, task `can_edit`), no confirmation dialog. */
export function ArchiveControl({
  task,
  actions,
  writable,
  attention,
}: {
  task: CacheRow;
  actions: Pick<TaskActions, "archive">;
  writable: boolean;
  attention: boolean;
}) {
  const note = useId();
  return (
    <div
      className="flex flex-col gap-1"
      data-archive={task.archived ? "archived" : "active"}
    >
      <span>
        {!writable || !task.can_edit ? (
          <Button
            disabled
            reason={!writable ? copy.NOT_WRITABLE : CONTROLS_COPY.noEdit}
          >
            {task.archived ? CONTROLS_COPY.restore : CONTROLS_COPY.archive}
          </Button>
        ) : (
          <Button
            aria-describedby={note}
            onClick={() => void actions.archive(task.id, !task.archived)}
          >
            {task.archived ? CONTROLS_COPY.restore : CONTROLS_COPY.archive}
          </Button>
        )}
      </span>
      <p id={note} className="text-xs text-muted-foreground">
        {CONTROLS_COPY.archiveNote}
      </p>
      {attention ? (
        <p className="text-xs text-destructive">
          {CONTROLS_COPY.archiveConflict}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Who's on this" (Q8, D-10a-7): the mode, how many take part (names are WEB-11a's), my own result, the joint line (only ever the server's)
 * and "Your settings" (enrolment: online-only, one attempt per body).
 */
export function Participation({
  row,
  joint,
  progressRows,
}: {
  row: RowModel;
  joint: JointAnswer | null;
  progressRows: readonly CacheRow[];
}) {
  const env = useTasksEnv();
  const heading = useId();
  const { data } = row;
  const others = data.participants.filter((id) => id !== env.accountId);
  const visible = new Map<string, boolean>();
  for (const p of progressRows) {
    const state = parseProgressState(p.value);
    if (state !== null)
      visible.set(state.subject_account_id, state.aggregate_consent);
  }
  const line = jointLine({
    participation: data.definition.participation,
    serverOutcome: joint?.outcome ?? null,
    asOf: joint?.at ?? null,
    online: env.online,
    othersVisibleWithConsent: others.map((id) => visible.get(id) === true),
  });
  const lineText =
    line.kind === "server"
      ? copy.JOINT.server(
          line.outcome,
          momentLabel(
            line.asOf,
            env.now(),
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          ),
        )
      : line.kind === "last_checked"
        ? copy.JOINT.lastChecked(
            line.outcome,
            momentLabel(
              line.asOf,
              env.now(),
              Intl.DateTimeFormat().resolvedOptions().timeZone,
            ),
          )
        : line.kind === "withheld"
          ? copy.JOINT.withheld
          : line.kind === "anyone_unknown"
            ? copy.JOINT.anyoneUnknown
            : line.kind === "offline"
              ? copy.JOINT.offline
              : copy.JOINT.notKnown;
  const mine =
    row.personal.kind === "result"
      ? `${copy.OUTCOME[row.personal.outcome]}${row.personal.provisional ? ` (${copy.PROVISIONAL})` : ""}`
      : row.personal.kind === "unavailable"
        ? copy.PILL.unavailable
        : "—";
  const shared = data.definition.participation !== "personal";
  return (
    <section
      aria-labelledby={heading}
      className="flex flex-col gap-2"
      data-participation=""
    >
      <h2
        id={heading}
        className="text-base font-semibold tracking-tight text-foreground"
      >
        {CONTROLS_COPY.whoHeading}
      </h2>
      <p className="text-sm text-foreground">
        {copy.PARTICIPATION[data.definition.participation]} ·{" "}
        {whoLabel(row, env.accountId)}
      </p>
      <p className="text-xs text-muted-foreground">
        {copy.PARTICIPATION_LINE[data.definition.participation]}
      </p>
      <p className="text-sm text-foreground" data-my-result="">
        {CONTROLS_COPY.mine}: {mine}
      </p>
      {shared ? (
        <p className="text-sm text-foreground" data-joint-line={line.kind}>
          {copy.JOINT.heading}: {lineText}
        </p>
      ) : null}
      {shared ? <EnrolmentSettings taskId={data.task_id} /> : null}
    </section>
  );
}

/**
 * The definite answers to a change: they end its attempt. Anything else (no answer, not sent, offline, closed) may leave an earlier send
 * of the same body unresolved, so its command and key are kept for Try again (revision 11, design assessment DA-1: a retry found offline
 * says nothing about whether the first send committed).
 */
const DEFINITE: ReadonlySet<string> = new Set([
  "conflict",
  "operation_conflict",
  "forbidden",
  "not_found",
  "invalid",
]);

type Change = {
  active?: boolean;
  aggregate_consent?: boolean;
  policy?: Policy;
};

/**
 * "Your settings" (enrolment, D-10a-7; revision 4, R11): online-only, ONE attempt per body. The attempt is taken synchronously before the
 * request (`startEnrolment`, page memory), and a repeated activation sends nothing. An uncertain answer keeps the exact command and key for
 * Try again (never resent on its own). A read asked before a change was answered is never the current state: it is shown only when
 * nothing is (disabled).
 *
 * Revision 10 (R22; task `states.md` R2/F1): every change sends the COMPLETE enrolment (`enrolCommand`), its audience included, so Leave
 * and the consent keep the audience that was read. Joining (first time or again) asks the aggregate-consent question explicitly and shows
 * the audience the new progress will have, to keep or change, before Join: the current default sharing the first time (read for the
 * purpose; unknown is never shown as Private), the audience last used when rejoining. Enrolled, "Change…" edits the audience with its own
 * Save and Cancel.
 *
 * Revision 11 (R23; design assessment C1-C3): a change owns the settings from the moment it is admitted until a read asked AFTER its answer
 * is accepted (the change's cycle, page memory): meanwhile nothing here is edited, chosen (an open directory lookup included) or sent, and
 * every edit is admitted when it happens, not only by a disabled control. So the answer and the read that follows can only end the edits
 * that were sent. A failed read leaves the cycle open, with its Try again (a read, never a send). A draft lived here (revision 12 below
 * moved it to page memory, and ends it only on its own SUCCESS: a refused change no longer ends it); one with edits not yet sent is never
 * dropped by a read, nor moved onto another version: it is kept, unsaved, until it is discarded. Leave and the consent wait while an
 * audience edit is unsaved.
 *
 * Revision 12 (R23/R25; design assessment C1-C5): the draft belongs to the PAGE (`EnrolmentDraft` in page memory, per identity and task),
 * not to this component, so an ordinary remount of the protected tree shows it again (after its own authorised read; a refused read of the
 * enrolment removes it). Being sent is not being saved: a change captures the draft's session and revision (`EnrolmentTicket`), and only
 * its SUCCESS, followed by the current read, ends that exact revision. A refused or uncertain change keeps the draft, unsaved, beside the
 * settings read (editable on the same version; kept, with Discard, on another): it is never resent, rebased or replaced by the read.
 *
 * Revision 13 (R26): the first Join's first choice, which begins the draft, keeps the form it was made in (`FirstJoin` renders it before
 * and after), so the control chosen keeps focus.
 */
function EnrolmentSettings({ taskId }: { taskId: string }) {
  const env = useTasksEnv();
  const heading = useId();
  const readKey = `enrolment:${taskId}`;
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [state, setState] = useState<
    "idle" | "loading" | "unavailable" | "refused" | "saved"
  >("idle");
  const [reload, setReload] = useState(0);
  const [, changed] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeEnrolment(changed), []);
  const attempt = enrolmentAttemptOf(env.identity, taskId);
  const lock = enrolmentLock(env.identity, taskId);
  const draft = enrolmentDraftOf(env.identity, taskId);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A change answered (here, or before a remount: then the mount's read is the one) is followed by a read.
  const reading = lock?.phase === "reading" ? lock.generation : 0;
  const readFor = useRef(reading);
  useEffect(() => {
    if (reading !== 0 && reading !== readFor.current) setReload((n) => n + 1);
    readFor.current = reading;
  }, [reading]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read after a change or a retry
  useEffect(() => {
    if (!env.online) return;
    if (refusalOf(env.identity, readKey) !== null) {
      setState("unavailable");
      return;
    }
    let live = true;
    const read = askEnrolment(env.identity, taskId);
    setState((s) => (s === "saved" || s === "refused" ? s : "loading"));
    void env.api.readEnrolment(taskId).then((result) => {
      noteIfRefused(env.identity, readKey, result);
      if (!live) return;
      const got = result.ok ? result.value : null;
      const answer = answerEnrolment(env.identity, taskId, read, got);
      if (result.ok) {
        const value = result.value;
        if (answer === "current") {
          // The current state. It ended only a draft whose own change was saved (page memory: `answerEnrolment`); any other is kept.
          setEnrolment(value);
        } else setEnrolment((shown) => shown ?? value);
        setState((s) => (s === "loading" ? "idle" : s));
      } else if (result.kind !== "closed" && answer !== "outdated")
        setState("unavailable");
    });
    return () => {
      live = false;
    };
  }, [env.api, env.online, env.identity, taskId, reload]);
  // Every edit, opening and discard is admitted by the page owner WHEN IT HAPPENS (nothing while a change is sent or confirmed): a control
  // rendered before a change was sent can still be pressed in the same turn.
  const deliver = async (mine: EnrolmentAttempt) => {
    // The captured body is what is sent, byte for byte, now and on Try again (R22: its policy too).
    const result = await env.api.enrol(JSON.parse(mine.body), mine.key);
    const definite = result.ok || DEFINITE.has(result.kind);
    settleEnrolment(
      env.identity,
      taskId,
      mine,
      result.ok ? "saved" : definite ? "refused" : "uncertain",
    );
    if (!mounted.current) return;
    if (result.ok) setState("saved");
    else if (definite) setState("refused");
    else if (result.kind !== "closed") setState("idle");
  };
  /** Sends `command` if its attempt is taken (nothing of the task pending or unconfirmed): true when it was. */
  const send = (command: EnrolCommand, ticket?: EnrolmentTicket): boolean => {
    const mine = startEnrolment(
      env.identity,
      taskId,
      command,
      env.newId,
      ticket,
    );
    if (mine === null) return false;
    void deliver(mine);
    return true;
  };
  // A draft never outlives its identity: page memory is per identity, and another identity's is gone (revision 11 S13).
  const held = draft;
  const stale =
    held !== null &&
    enrolment !== null &&
    held.base.version !== enrolment.version;
  /** An edit of the draft for `base` (begun from `seed` if there is none yet); a kept draft of another version is never edited. */
  const edit = (
    base: Enrolment,
    seed: Policy,
    next: { policy?: Policy; consent?: boolean },
  ) => {
    if (env.writable)
      editEnrolmentDraft(env.identity, taskId, base, seed, next);
  };
  /** Sends the draft's change, naming the revision it submits: only that revision's success can end it. */
  const submit = (d: Draft, change: Change) => {
    send(enrolCommand(taskId, d.base, change), {
      session: d.session,
      revision: d.revision,
    });
  };
  const discard = () => {
    if (env.writable && held !== null)
      discardEnrolmentDraft(env.identity, taskId, held.session);
  };
  const uncertain = attempt?.phase === "uncertain" ? attempt : null;
  const blocked = !env.writable
    ? copy.NOT_WRITABLE
    : lock?.phase === "sending"
      ? CONTROLS_COPY.sending
      : lock !== null
        ? CONTROLS_COPY.confirming
        : null;
  // A full page refuses a NEW draft or change with why (nothing held is dropped for it); one held here is never refused.
  const free =
    blocked ??
    (enrolmentFull(env.identity, taskId) ? CONTROLS_COPY.full : null);
  // While a draft of an earlier version is kept, it is discarded before anything else is changed (an opened editor holds nothing).
  const kept = stale && held.revision > 0;
  const actions = free ?? (kept ? CONTROLS_COPY.discardFirst : null);
  const current = stale ? null : held;
  const joinForm = (shown: Enrolment, seed: Policy, note: string) => (
    <JoinForm
      seed={seed}
      note={note}
      draft={current}
      blocked={actions}
      edit={(next) => edit(shown, seed, next)}
      join={(d) => {
        if (d.consent !== null)
          submit(d, {
            active: true,
            aggregate_consent: d.consent,
            policy: d.policy,
          });
      }}
    />
  );
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby={heading}
      data-enrolment=""
    >
      <h3 id={heading} className="text-sm font-medium text-foreground">
        {CONTROLS_COPY.settings}
      </h3>
      {!env.online ? (
        <p className="text-xs text-muted-foreground">{CONTROLS_COPY.offline}</p>
      ) : state === "unavailable" ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {CONTROLS_COPY.enrolUnavailable}
          </span>
          <Button
            variant="ghost"
            onClick={() => {
              forgetRefusal(env.identity, readKey);
              setState("loading");
              setReload((n) => n + 1);
            }}
          >
            {copy.TRY_AGAIN}
          </Button>
        </span>
      ) : enrolment === null ? (
        <p className="text-xs text-muted-foreground">{CONTROLS_COPY.loading}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {kept && held !== null ? (
            <KeptDraft draft={held} blocked={blocked} discard={discard} />
          ) : null}
          {enrolment.active ? (
            <Enrolled
              enrolment={enrolment}
              draft={current}
              blocked={actions}
              open={() => {
                if (env.writable)
                  openEnrolmentDraft(env.identity, taskId, enrolment);
              }}
              edit={(policy) => edit(enrolment, enrolment.policy, { policy })}
              cancel={discard}
              save={(d) => submit(d, { policy: d.policy })}
              change={(next) => send(enrolCommand(taskId, enrolment, next))}
            />
          ) : enrolment.version === 0 ? (
            // One path before and after the first choice (revision 13, R26): the choice that begins the draft keeps its form, and focus.
            <FirstJoin
              begun={current}
              form={(seed) =>
                joinForm(enrolment, seed, CONTROLS_COPY.defaultAudience)
              }
            />
          ) : (
            joinForm(enrolment, enrolment.policy, CONTROLS_COPY.lastAudience)
          )}
          {uncertain !== null ? (
            <span
              className="flex flex-wrap items-center gap-2"
              data-enrolment-uncertain=""
            >
              <span className="text-xs text-destructive">
                {CONTROLS_COPY.enrolFailed}
              </span>
              {env.writable ? (
                <Act
                  variant="ghost"
                  blocked={blocked}
                  onClick={() => void send(uncertain.command)}
                >
                  {copy.TRY_AGAIN}
                </Act>
              ) : null}
            </span>
          ) : state === "refused" ? (
            <p className="text-xs text-muted-foreground">
              {CONTROLS_COPY.enrolRefused}
            </p>
          ) : state === "saved" ? (
            <p className="text-xs text-muted-foreground">
              {CONTROLS_COPY.saved}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** A disabled control with why, or the enabled one. */
function Act({
  blocked,
  onClick,
  children,
  ...rest
}: {
  blocked: string | null;
  onClick(): void;
  children: string;
  variant?: "ghost" | "default";
  "data-enrol-act"?: string;
}) {
  return blocked !== null ? (
    <Button {...rest} disabled reason={blocked}>
      {children}
    </Button>
  ) : (
    <Button {...rest} onClick={onClick}>
      {children}
    </Button>
  );
}

/** Enrolled: Leave, the consent and the audience, each resending everything it does not change. */
function Enrolled({
  enrolment,
  draft,
  blocked,
  open,
  edit,
  cancel,
  save,
  change,
}: {
  enrolment: Enrolment;
  /** The audience being edited ("Change…"), or null when the editor is closed. */
  draft: Draft | null;
  blocked: string | null;
  open(): void;
  edit(policy: Policy): void;
  cancel(): void;
  save(draft: Draft): void;
  change(next: Change): void;
}) {
  const unchanged =
    draft !== null &&
    canonicalBody(draft.policy) === canonicalBody(enrolment.policy);
  // An audience edit not yet saved (unsent, refused or uncertain) is saved or cancelled first: never sent with Leave or the consent, nor
  // lost to their answer.
  const others =
    blocked ??
    (draft !== null && draft.revision > 0 ? CONTROLS_COPY.finishFirst : null);
  return (
    <>
      <span>
        <Act
          blocked={others}
          data-enrol-act="leave"
          onClick={() => change({ active: false })}
        >
          {CONTROLS_COPY.leave}
        </Act>
      </span>
      <label className="inline-flex min-h-11 items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={enrolment.aggregate_consent}
          disabled={others !== null}
          onChange={() =>
            change({ aggregate_consent: !enrolment.aggregate_consent })
          }
          className="size-[15px]"
        />
        {CONTROLS_COPY.consent}
      </label>
      <div className="flex flex-col gap-2" data-enrol-audience="">
        <p className="text-sm text-foreground">
          {CONTROLS_COPY.audienceHeading}:{" "}
          {CONTROLS_COPY.audienceLine(enrolment.policy)}
        </p>
        <p className="text-xs text-muted-foreground">
          {CONTROLS_COPY.audienceNote}
        </p>
        {draft === null ? (
          <span>
            <Act variant="ghost" blocked={blocked} onClick={open}>
              {CONTROLS_COPY.changeAudience}
            </Act>
          </span>
        ) : (
          <>
            <AudienceChooser
              policy={draft.policy}
              onChange={edit}
              blocked={blocked}
            />
            <span className="flex flex-wrap items-center gap-2">
              <Act variant="ghost" blocked={blocked} onClick={cancel}>
                {CONTROLS_COPY.cancel}
              </Act>
              <Act
                variant="default"
                blocked={blocked ?? (unchanged ? CONTROLS_COPY.noChange : null)}
                data-enrol-act="save-audience"
                onClick={() => save(draft)}
              >
                {CONTROLS_COPY.saveAudience}
              </Act>
            </span>
          </>
        )}
      </div>
    </>
  );
}

/** A draft with unsent edits of an earlier version: shown as it was, never sent onto the version shown; discarding it is explicit. */
function KeptDraft({
  draft,
  blocked,
  discard,
}: {
  draft: Draft;
  blocked: string | null;
  discard(): void;
}) {
  return (
    <div className="flex flex-col gap-2" data-enrol-kept="">
      <p className="text-xs text-destructive">{CONTROLS_COPY.keptDraft}</p>
      {draft.consent === null ? null : (
        <p className="text-sm text-foreground">
          {draft.consent ? CONTROLS_COPY.consentYes : CONTROLS_COPY.consentNo}
        </p>
      )}
      <AudienceChooser
        policy={draft.policy}
        onChange={() => undefined}
        blocked={CONTROLS_COPY.keptDraft}
      />
      <span>
        <Act variant="ghost" blocked={blocked} onClick={discard}>
          {CONTROLS_COPY.discard}
        </Act>
      </span>
    </div>
  );
}

type Seed =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; policy: Policy };

/**
 * The first Join (version 0): the read enrolment's empty policy is a placeholder, not an audience. The audience offered is the CURRENT
 * default sharing for progress, from a defaults snapshot asked for when this opened; until it is known nothing can be joined, and a failed
 * read says so with Try again (never shown as Private). A draft already begun keeps its own audience whatever is read here.
 *
 * Revision 13 (R26; design assessment C1/C2, I2/I7): the first choice begins the page's draft, and the form stays where it was: the draft is
 * rendered by the same `form` at the same place as the seed was, so React keeps the mounted form, its chooser and the focussed control. A
 * draft is preferred to the defaults (loading, failed or answered later), and with one there is nothing to ask for: the snapshot is read
 * (`SeedRead`, beside the form, never around it) only while nothing is begun, as before.
 */
function FirstJoin({
  begun,
  form,
}: {
  /** The draft of this first Join (a choice made), or null. */
  begun: Draft | null;
  form(seed: Policy): ReactNode;
}) {
  const [seed, setSeed] = useState<Seed>({ status: "loading" });
  const [round, setRound] = useState(0);
  return (
    <>
      {begun === null ? <SeedRead round={round} found={setSeed} /> : null}
      {begun !== null ? (
        form(begun.policy)
      ) : seed.status === "ready" ? (
        form(seed.policy)
      ) : (
        <>
          {seed.status === "loading" ? (
            <p className="text-xs text-muted-foreground">
              {CONTROLS_COPY.defaultLoading}
            </p>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {CONTROLS_COPY.defaultFailed}
              </span>
              <Button variant="ghost" onClick={() => setRound((n) => n + 1)}>
                {copy.TRY_AGAIN}
              </Button>
            </span>
          )}
          <span>
            <Button disabled reason={CONTROLS_COPY.audienceUnknown}>
              {CONTROLS_COPY.join}
            </Button>
          </span>
        </>
      )}
    </>
  );
}

/** The first Join's defaults snapshot, asked for when it mounts and on each Try again (`round`); it renders nothing. */
function SeedRead({
  round,
  found,
}: {
  round: number;
  found(seed: Seed): void;
}) {
  const defaults = useSharingDefaults();
  const source = useRef(defaults);
  source.current = defaults;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one snapshot read per opening or Try again
  useEffect(() => {
    let live = true;
    found({ status: "loading" });
    const { acquire, boundary } = source.current;
    void acquire(boundary()).then((got) => {
      if (live)
        found(
          got.outcome === "fetched"
            ? { status: "ready", policy: progressDefaultPolicy(got.record) }
            : { status: "failed" },
        );
    });
    return () => {
      live = false;
    };
  }, [round]);
  return null;
}

/** Joining: the explicit consent choice and the audience (seeded, kept or changed), then Join with both. */
function JoinForm({
  seed,
  note,
  draft,
  blocked,
  edit,
  join,
}: {
  seed: Policy;
  note: string;
  /** The choices made so far, or null (nothing chosen: the seed, and no consent). */
  draft: Draft | null;
  blocked: string | null;
  edit(next: { policy?: Policy; consent?: boolean }): void;
  join(draft: Draft): void;
}) {
  const legend = useId();
  const consent = draft?.consent ?? null;
  const choice = (value: boolean, label: string) => (
    <label className="inline-flex min-h-11 items-center gap-2 text-sm text-foreground">
      <input
        type="radio"
        name={legend}
        checked={consent === value}
        disabled={blocked !== null}
        onChange={() => edit({ consent: value })}
        className="size-[15px]"
      />
      {label}
    </label>
  );
  return (
    <>
      <fieldset className="flex flex-col" data-enrol-consent="">
        <legend id={legend} className="text-sm text-foreground">
          {CONTROLS_COPY.joinConsent}
        </legend>
        {choice(true, CONTROLS_COPY.consentYes)}
        {choice(false, CONTROLS_COPY.consentNo)}
      </fieldset>
      <div className="flex flex-col gap-2" data-enrol-audience="">
        <p className="text-sm text-foreground">
          {CONTROLS_COPY.audienceHeading}
        </p>
        <p className="text-xs text-muted-foreground">
          {note} {CONTROLS_COPY.audienceNote}
        </p>
        <AudienceChooser
          policy={draft?.policy ?? seed}
          onChange={(policy) => edit({ policy })}
          blocked={blocked}
        />
      </div>
      <span>
        <Act
          blocked={
            blocked ?? (consent === null ? CONTROLS_COPY.chooseConsent : null)
          }
          data-enrol-act="join"
          onClick={() => {
            if (draft !== null) join(draft);
          }}
        >
          {CONTROLS_COPY.join}
        </Act>
      </span>
    </>
  );
}
