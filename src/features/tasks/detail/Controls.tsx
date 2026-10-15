import { useEffect, useId, useReducer, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { type CacheRow, type Policy, useSharingDefaults } from "../../../data";
// The sharing feature's public chooser, from its own module (see `sharing/index.ts`).
import { AudienceChooser } from "../../sharing/AudienceChooser";
import type { TaskActions } from "../actions";
import type { EnrolCommand } from "../api";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { momentLabel } from "../format";
import {
  enrolmentAttemptOf,
  forgetRefusal,
  type JointAnswer,
  noteIfRefused,
  refusalOf,
  settleEnrolment,
  startEnrolment,
  subscribeEnrolment,
} from "../memory";
import { canonicalBody } from "../model/attempt";
import { type Enrolment, parseProgressState } from "../model/contract";
import {
  copyPolicy,
  enrolCommand,
  progressDefaultPolicy,
} from "../model/enrolment";
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
  you: "You",
  youAnd: (n: number) => `You and ${n} other${n === 1 ? "" : "s"}`,
  people: (n: number) => `${n} ${n === 1 ? "person" : "people"}`,
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
      <h2 id={heading} className="text-[15px] font-medium text-ink-1">
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
      <p id={note} className="text-[12.5px] text-ink-2">
        {CONTROLS_COPY.closeNote}
      </p>
      {conflict ? (
        <p
          className="text-[12.5px] text-conflict-text"
          data-closure-conflict=""
        >
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
      <p id={note} className="text-[12px] text-ink-2">
        {CONTROLS_COPY.archiveNote}
      </p>
      {attention ? (
        <p className="text-[12.5px] text-conflict-text">
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
      <h2 id={heading} className="text-[15px] font-medium text-ink-1">
        {CONTROLS_COPY.whoHeading}
      </h2>
      <p className="text-[13px] text-ink-1">
        {copy.PARTICIPATION[data.definition.participation]} ·{" "}
        {data.participants.includes(env.accountId)
          ? others.length === 0
            ? CONTROLS_COPY.you
            : CONTROLS_COPY.youAnd(others.length)
          : CONTROLS_COPY.people(data.participants.length)}
      </p>
      <p className="text-[12.5px] text-ink-2">
        {copy.PARTICIPATION_LINE[data.definition.participation]}
      </p>
      <p className="text-[13px] text-ink-1" data-my-result="">
        {CONTROLS_COPY.mine}: {mine}
      </p>
      {shared ? (
        <p className="text-[13px] text-ink-1" data-joint-line={line.kind}>
          {copy.JOINT.heading}: {lineText}
        </p>
      ) : null}
      {shared ? <EnrolmentSettings taskId={data.task_id} /> : null}
    </section>
  );
}

/**
 * "Your settings" (enrolment, D-10a-7; revision 4, R11): online-only, ONE attempt per body. The attempt is taken synchronously before the
 * request (`startEnrolment`, page memory): while it is pending every control here is disabled with a reason, and a repeated activation
 * sends nothing. An uncertain answer keeps the exact command and key for Try again (never resent on its own). Every answer, and the end
 * of a pending attempt seen after a remount, reads the enrolment again; a read asked before a change was sent is not shown, and one
 * answered while a change is pending never replaces what is shown (both may predate the change).
 *
 * Revision 10 (R22; task `states.md` R2/F1): every change sends the COMPLETE enrolment (`enrolCommand`), its audience included, so Leave
 * and the consent keep the audience that was read. Joining (first time or again) asks the aggregate-consent question explicitly and shows
 * the audience the new progress will have, to keep or change, before Join: the current default sharing the first time (read for the
 * purpose; unknown is never shown as Private), the audience last used when rejoining. Enrolled, "Change…" edits the audience with its own
 * Save and Cancel. A choice belongs to the enrolment version it was made on: once another version is shown it is dropped (never rebased),
 * and the person sees the new state; a stale version is refused by the server (`expected_version`).
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
  const pending = attempt?.phase === "pending";
  // Changes sent by this mount: a read asked before the latest one may predate it.
  const sent = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A pending attempt that ended (here or before a remount) is followed by a read.
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current && !pending) setReload((n) => n + 1);
    wasPending.current = pending;
  }, [pending]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read after a change or a retry
  useEffect(() => {
    if (!env.online) return;
    if (refusalOf(env.identity, readKey) !== null) {
      setState("unavailable");
      return;
    }
    let live = true;
    const asked = sent.current;
    setState((s) => (s === "saved" || s === "refused" ? s : "loading"));
    void env.api.readEnrolment(taskId).then((result) => {
      noteIfRefused(env.identity, readKey, result);
      if (!live || asked !== sent.current) return;
      // While a change is pending a read may predate it: it never replaces what is shown (a screen mounted meanwhile shows it, disabled).
      const pendingNow =
        enrolmentAttemptOf(env.identity, taskId)?.phase === "pending";
      if (result.ok) {
        setEnrolment((shown) =>
          pendingNow && shown !== null ? shown : result.value,
        );
        setState((s) => (s === "loading" ? "idle" : s));
      } else if (result.kind !== "closed") setState("unavailable");
    });
    return () => {
      live = false;
    };
  }, [env.api, env.online, env.identity, taskId, reload]);
  const send = async (command: EnrolCommand) => {
    const mine = startEnrolment(env.identity, taskId, command, env.newId);
    if (mine === null) return;
    sent.current += 1;
    // The captured body is what is sent, byte for byte, now and on Try again (R22: its policy too).
    const result = await env.api.enrol(JSON.parse(mine.body), mine.key);
    const definite =
      result.ok ||
      (result.kind !== "uncertain" &&
        result.kind !== "not_sent" &&
        result.kind !== "closed");
    settleEnrolment(
      env.identity,
      taskId,
      mine,
      definite ? "definite" : "uncertain",
    );
    if (!mounted.current) return;
    if (result.ok) setState("saved");
    else if (definite) setState("refused");
    else if (result.kind !== "closed") setState("idle");
  };
  const change = (next: {
    active?: boolean;
    aggregate_consent?: boolean;
    policy?: Policy;
  }) => {
    if (enrolment === null) return;
    void send(enrolCommand(taskId, enrolment, next));
  };
  const uncertain = attempt?.phase === "uncertain" ? attempt : null;
  const blocked = !env.writable
    ? copy.NOT_WRITABLE
    : pending
      ? CONTROLS_COPY.sending
      : null;
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby={heading}
      data-enrolment=""
    >
      <h3 id={heading} className="text-[13.5px] font-medium text-ink-1">
        {CONTROLS_COPY.settings}
      </h3>
      {!env.online ? (
        <p className="text-[12.5px] text-ink-2">{CONTROLS_COPY.offline}</p>
      ) : state === "unavailable" ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-ink-2">
            {CONTROLS_COPY.enrolUnavailable}
          </span>
          <Button
            variant="quiet"
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
        <p className="text-[12.5px] text-ink-2">{CONTROLS_COPY.loading}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {enrolment.active ? (
            <Enrolled
              key={enrolment.version}
              enrolment={enrolment}
              blocked={blocked}
              change={change}
            />
          ) : enrolment.version === 0 ? (
            <FirstJoin
              blocked={blocked}
              join={(consent, policy) =>
                change({ active: true, aggregate_consent: consent, policy })
              }
            />
          ) : (
            <JoinForm
              key={enrolment.version}
              seed={enrolment.policy}
              note={CONTROLS_COPY.lastAudience}
              blocked={blocked}
              join={(consent, policy) =>
                change({ active: true, aggregate_consent: consent, policy })
              }
            />
          )}
          {uncertain !== null ? (
            <span
              className="flex flex-wrap items-center gap-2"
              data-enrolment-uncertain=""
            >
              <span className="text-[12.5px] text-conflict-text">
                {CONTROLS_COPY.enrolFailed}
              </span>
              {env.writable ? (
                <Button
                  variant="quiet"
                  onClick={() => void send(uncertain.command)}
                >
                  {copy.TRY_AGAIN}
                </Button>
              ) : null}
            </span>
          ) : state === "refused" ? (
            <p className="text-[12.5px] text-ink-2">
              {CONTROLS_COPY.enrolRefused}
            </p>
          ) : state === "saved" ? (
            <p className="text-[12.5px] text-ink-2">{CONTROLS_COPY.saved}</p>
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
  variant?: "quiet" | "primary";
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
  blocked,
  change,
}: {
  enrolment: Enrolment;
  blocked: string | null;
  change(next: {
    active?: boolean;
    aggregate_consent?: boolean;
    policy?: Policy;
  }): void;
}) {
  // The audience being edited ("Change…"), from this version's policy; null when the editor is closed (Cancel sends nothing).
  const [draft, setDraft] = useState<Policy | null>(null);
  const unchanged =
    draft !== null && canonicalBody(draft) === canonicalBody(enrolment.policy);
  return (
    <>
      <span>
        <Act
          blocked={blocked}
          data-enrol-act="leave"
          onClick={() => change({ active: false })}
        >
          {CONTROLS_COPY.leave}
        </Act>
      </span>
      <label className="inline-flex min-h-11 items-center gap-2 text-[13.5px] text-ink-1">
        <input
          type="checkbox"
          checked={enrolment.aggregate_consent}
          disabled={blocked !== null}
          onChange={() =>
            change({ aggregate_consent: !enrolment.aggregate_consent })
          }
          className="size-[15px]"
        />
        {CONTROLS_COPY.consent}
      </label>
      <div className="flex flex-col gap-2" data-enrol-audience="">
        <p className="text-[13px] text-ink-1">
          {CONTROLS_COPY.audienceHeading}:{" "}
          {CONTROLS_COPY.audienceLine(enrolment.policy)}
        </p>
        <p className="text-[12.5px] text-ink-2">{CONTROLS_COPY.audienceNote}</p>
        {draft === null ? (
          <span>
            <Act
              variant="quiet"
              blocked={blocked}
              onClick={() => setDraft(copyPolicy(enrolment.policy))}
            >
              {CONTROLS_COPY.changeAudience}
            </Act>
          </span>
        ) : (
          <>
            <AudienceChooser
              policy={draft}
              onChange={setDraft}
              disabled={blocked !== null}
            />
            <span className="flex flex-wrap items-center gap-2">
              <Button variant="quiet" onClick={() => setDraft(null)}>
                {CONTROLS_COPY.cancel}
              </Button>
              <Act
                variant="primary"
                blocked={blocked ?? (unchanged ? CONTROLS_COPY.noChange : null)}
                data-enrol-act="save-audience"
                onClick={() => change({ policy: draft })}
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

type Seed =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; policy: Policy };

/**
 * The first Join (version 0): the read enrolment's empty policy is a placeholder, not an audience. The audience offered is the CURRENT
 * default sharing for progress, from a defaults snapshot asked for when this opened; until it is known nothing can be joined, and a failed
 * read says so with Try again (never shown as Private).
 */
function FirstJoin({
  blocked,
  join,
}: {
  blocked: string | null;
  join(consent: boolean, policy: Policy): void;
}) {
  const defaults = useSharingDefaults();
  const source = useRef(defaults);
  source.current = defaults;
  const [seed, setSeed] = useState<Seed>({ status: "loading" });
  const [round, setRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one snapshot read per opening or Try again
  useEffect(() => {
    let live = true;
    setSeed({ status: "loading" });
    const { acquire, boundary } = source.current;
    void acquire(boundary()).then((got) => {
      if (live)
        setSeed(
          got.outcome === "fetched"
            ? { status: "ready", policy: progressDefaultPolicy(got.record) }
            : { status: "failed" },
        );
    });
    return () => {
      live = false;
    };
  }, [round]);
  if (seed.status === "ready")
    return (
      <JoinForm
        seed={seed.policy}
        note={CONTROLS_COPY.defaultAudience}
        blocked={blocked}
        join={join}
      />
    );
  return (
    <>
      {seed.status === "loading" ? (
        <p className="text-[12.5px] text-ink-2">
          {CONTROLS_COPY.defaultLoading}
        </p>
      ) : (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-ink-2">
            {CONTROLS_COPY.defaultFailed}
          </span>
          <Button variant="quiet" onClick={() => setRound((n) => n + 1)}>
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
  );
}

/** Joining: the explicit consent choice and the audience (seeded, kept or changed), then Join with both. */
function JoinForm({
  seed,
  note,
  blocked,
  join,
}: {
  seed: Policy;
  note: string;
  blocked: string | null;
  join(consent: boolean, policy: Policy): void;
}) {
  const legend = useId();
  const [consent, setConsent] = useState<boolean | null>(null);
  const [policy, setPolicy] = useState(() => copyPolicy(seed));
  const choice = (value: boolean, label: string) => (
    <label className="inline-flex min-h-11 items-center gap-2 text-[13.5px] text-ink-1">
      <input
        type="radio"
        name={legend}
        checked={consent === value}
        disabled={blocked !== null}
        onChange={() => setConsent(value)}
        className="size-[15px]"
      />
      {label}
    </label>
  );
  return (
    <>
      <fieldset className="flex flex-col" data-enrol-consent="">
        <legend id={legend} className="text-[13px] text-ink-1">
          {CONTROLS_COPY.joinConsent}
        </legend>
        {choice(true, CONTROLS_COPY.consentYes)}
        {choice(false, CONTROLS_COPY.consentNo)}
      </fieldset>
      <div className="flex flex-col gap-2" data-enrol-audience="">
        <p className="text-[13px] text-ink-1">
          {CONTROLS_COPY.audienceHeading}
        </p>
        <p className="text-[12.5px] text-ink-2">
          {note} {CONTROLS_COPY.audienceNote}
        </p>
        <AudienceChooser
          policy={policy}
          onChange={setPolicy}
          disabled={blocked !== null}
        />
      </div>
      <span>
        <Act
          blocked={
            blocked ?? (consent === null ? CONTROLS_COPY.chooseConsent : null)
          }
          data-enrol-act="join"
          onClick={() => {
            if (consent !== null) join(consent, policy);
          }}
        >
          {CONTROLS_COPY.join}
        </Act>
      </span>
    </>
  );
}
