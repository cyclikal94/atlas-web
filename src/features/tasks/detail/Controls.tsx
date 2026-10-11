import { useEffect, useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import type { CacheRow } from "../../../data";
import type { TaskActions } from "../actions";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { momentLabel } from "../format";
import {
  forgetRefusal,
  type JointAnswer,
  noteRefusal,
  refusalOf,
} from "../memory";
import { type Attempt, nextAttempt } from "../model/attempt";
import { type Enrolment, parseProgressState } from "../model/contract";
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
  saved: "Saved.",
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

function EnrolmentSettings({ taskId }: { taskId: string }) {
  const env = useTasksEnv();
  const heading = useId();
  const readKey = `enrolment:${taskId}`;
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [state, setState] = useState<
    "idle" | "loading" | "unavailable" | "failed" | "refused" | "saved"
  >("idle");
  const [uncertain, setUncertain] = useState<Attempt | null>(null);
  const [reload, setReload] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read after a change or a retry
  useEffect(() => {
    if (!env.online) return;
    if (refusalOf(env.identity, readKey) !== null) {
      setState("unavailable");
      return;
    }
    let live = true;
    setState((s) =>
      s === "saved" || s === "refused" || s === "failed" ? s : "loading",
    );
    void env.api.readEnrolment(taskId).then((result) => {
      if (!live) return;
      if (result.ok) {
        setEnrolment(result.value);
        setState((s) => (s === "loading" ? "idle" : s));
      } else if (result.kind === "forbidden" || result.kind === "not_found") {
        noteRefusal(env.identity, readKey, result.kind);
        setState("unavailable");
      } else if (result.kind !== "closed") setState("unavailable");
    });
    return () => {
      live = false;
    };
  }, [env.api, env.online, env.identity, taskId, reload]);
  const send = async (next: {
    active: boolean;
    aggregate_consent: boolean;
  }) => {
    if (enrolment === null) return;
    const command = {
      kind: "enrol" as const,
      task_id: taskId,
      expected_version: enrolment.version,
      active: next.active,
      aggregate_consent: next.aggregate_consent,
    };
    const attempt = nextAttempt(uncertain, command, env.newId);
    const result = await env.api.enrol(command, attempt.key);
    if (result.ok) {
      setUncertain(null);
      setState("saved");
      setReload((n) => n + 1);
    } else if (result.kind === "uncertain" || result.kind === "not_sent") {
      setUncertain(attempt);
      setState("failed");
    } else if (result.kind !== "closed") {
      setUncertain(null);
      setState("refused");
      setReload((n) => n + 1);
    }
  };
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
          <span>
            {env.writable ? (
              <Button
                onClick={() =>
                  void send({
                    active: !enrolment.active,
                    aggregate_consent: enrolment.aggregate_consent,
                  })
                }
              >
                {enrolment.active ? CONTROLS_COPY.leave : CONTROLS_COPY.join}
              </Button>
            ) : (
              <Button disabled reason={copy.NOT_WRITABLE}>
                {enrolment.active ? CONTROLS_COPY.leave : CONTROLS_COPY.join}
              </Button>
            )}
          </span>
          <label className="inline-flex min-h-11 items-center gap-2 text-[13.5px] text-ink-1">
            <input
              type="checkbox"
              checked={enrolment.aggregate_consent}
              disabled={!env.writable}
              onChange={() =>
                void send({
                  active: enrolment.active,
                  aggregate_consent: !enrolment.aggregate_consent,
                })
              }
              className="size-[15px]"
            />
            {CONTROLS_COPY.consent}
          </label>
          {state === "failed" ? (
            <p className="text-[12.5px] text-conflict-text">
              {CONTROLS_COPY.enrolFailed}
            </p>
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
