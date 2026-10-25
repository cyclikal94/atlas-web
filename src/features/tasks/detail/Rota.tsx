import { useEffect, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { useSharingDefaults } from "../../../data";
import type { RotaConsentCommand, SetRotaCommand, TasksResult } from "../api";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { dayLabel } from "../format";
import { completeKept, keptKey, useKeptInput } from "../kept-input";
import { noteIfRefused } from "../memory";
import { type Attempt, nextAttempt } from "../model/attempt";
import type {
  OccurrenceData,
  RotaState,
  TaskDefinition,
  TaskResult,
} from "../model/contract";
import {
  addTo,
  labelOf,
  MAX_ROSTER,
  move,
  nextDates,
  nextOrdinal,
  project,
  removeFrom,
  setTurns,
} from "../model/rota";
import type { RowModel } from "../view";

/** Provisional copy (STAGED-ACCEPTANCE-20261011; docs/tasks.md WEB-10c checkpoint list). */
export const ROTA_COPY = {
  thisTurn: (label: string) => `This turn: ${label}`,
  nobody: "Nobody yet",
  takeTurns: "Take turns on this task",
  offline: "Changing turns needs a connection.",
  join: "Join this task first",
  sending: "Sending your change…",
  uncertain: "Couldn't confirm the change. Try again.",
  changed: "Your settings changed. The latest are shown.",
  refused: "This change wasn't accepted.",
  loading: "Loading turns",
  failed: "Couldn't load turns.",
  order: "Turn order…",
  title: "Turn order",
  lead: "The order people take turns in.",
  count: (n: number) => `${n} of ${MAX_ROSTER}`,
  up: "Move up",
  down: "Move down",
  first: "Already first",
  last: "Already last",
  remove: "Remove",
  add: "Add",
  couldAdd: "Could be added",
  couldAddNote:
    "Only people who've joined the task and agreed to take turns show up here.",
  noneEligible:
    "No one has joined this task and agreed to take turns, so there's no order to set.",
  gives: "What that gives you",
  day: "Day",
  turn: "Turn",
  status: "",
  alreadySet: "Already set",
  projected: "Projected",
  leftOpen: "Left open",
  noTurns: "No one will be given turns",
  keepNote:
    "Turns already set keep their person, even if you reorder or remove someone. A turn that hasn't been worked out yet is left open rather than handed to someone else without asking.",
  accessNote: "Being in the order doesn't give anyone access to the task.",
  save: "Save order",
  cancel: "Cancel",
  conflict: "Someone changed the order while you had it open.",
  reload: "Reload",
  saved: "Turn order saved.",
  nothingChanged: "Nothing has changed",
  you: "You",
} as const;

// ---- page memory: one attempt per body (D-10c-9; WEB-10a `model/attempt.ts`) -------------------------------------------------------
const attempts = new Map<string, Attempt>();
let attemptsFor = "";
function attemptOf(identity: string, key: string): Attempt | null {
  if (attemptsFor !== identity) {
    attempts.clear();
    attemptsFor = identity;
  }
  return attempts.get(key) ?? null;
}
function holdAttempt(identity: string, key: string, attempt: Attempt | null) {
  attemptOf(identity, key);
  if (attempt === null) attempts.delete(key);
  else attempts.set(key, attempt);
}

type Send =
  | { kind: "ok" }
  | { kind: "conflict" }
  | { kind: "refused"; requestId?: string }
  | { kind: "uncertain" }
  | { kind: "offline" };

/**
 * One online-only access command, one attempt per canonical body: an uncertain answer keeps the attempt (its key and body), so "Try again"
 * resends exactly that; a definite answer ends it, and the next change is a new key. Offline, nothing is sent.
 */
async function sendAccess(
  env: ReturnType<typeof useTasksEnv>,
  memoryKey: string,
  command: SetRotaCommand | RotaConsentCommand,
): Promise<Send> {
  if (!env.online) return { kind: "offline" };
  const attempt = nextAttempt(
    attemptOf(env.identity, memoryKey),
    command,
    env.newId,
  );
  holdAttempt(env.identity, memoryKey, attempt);
  const result: TasksResult<TaskResult> = await env.api.access(
    JSON.parse(attempt.body),
    attempt.key,
  );
  if (result.ok) {
    holdAttempt(env.identity, memoryKey, null);
    return { kind: "ok" };
  }
  switch (result.kind) {
    case "uncertain":
    case "not_sent":
    case "closed":
    case "offline":
      return { kind: "uncertain" };
    case "conflict":
    case "operation_conflict":
      holdAttempt(env.identity, memoryKey, null);
      return { kind: "conflict" };
    default:
      holdAttempt(env.identity, memoryKey, null);
      return {
        kind: "refused",
        ...(result.requestId ? { requestId: result.requestId } : {}),
      };
  }
}

/**
 * The rota of the task (`GET /tasks/{id}/rota`) and whether I take part now (`GET /tasks/{id}/enrolment`), online, per identity.
 * Exported for its hook-level identity test (the screens remount on another identity, which hides this hook's own rule).
 */
export function useRota(taskId: string) {
  const env = useTasksEnv();
  const [state, setState] = useState<{
    scope: string;
    rota:
      | { kind: "loading" | "offline" | "error" }
      | { kind: "ready"; value: RotaState };
    enrolled: boolean | null;
  }>({ scope: "", rota: { kind: "loading" }, enrolled: null });
  const scope = `${env.identity}\u0000${taskId}`;
  const current = useRef(scope);
  current.current = scope;
  const [again, setAgain] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again for another identity, the connection or a change made
  useEffect(() => {
    if (!env.online) {
      setState({ scope, rota: { kind: "offline" }, enrolled: null });
      return;
    }
    const asked = scope;
    void Promise.all([
      env.api.readRota(taskId),
      env.api.readEnrolment(taskId),
    ]).then(([rota, enrolment]) => {
      noteIfRefused(env.identity, `rota:${taskId}`, rota);
      noteIfRefused(env.identity, `enrolment:${taskId}`, enrolment);
      // An answer of another identity or task is never shown (CM-384).
      if (current.current !== asked) return;
      setState({
        scope: asked,
        rota: rota.ok
          ? { kind: "ready", value: rota.value }
          : { kind: "error" },
        enrolled: enrolment.ok ? enrolment.value.active : null,
      });
    });
  }, [scope, env.online, again]);
  const value = state.scope === scope ? state : null;
  return {
    rota: value?.rota ?? { kind: "loading" as const },
    enrolled: value?.enrolled ?? null,
    reload: () => setAgain((n) => n + 1),
  };
}

/** Usernames this page knows (the household membership in the sharing defaults), by account id. */
function useUsernames(): ReadonlyMap<string, string> {
  const record = useSharingDefaults().record;
  const out = new Map<string, string>();
  for (const household of record?.snapshot.households ?? [])
    for (const member of household.members)
      out.set(member.account_id, member.username);
  return out;
}
const anonymous = (id: string) => `Someone (${id.slice(0, 4)}…)`;

/**
 * The rota on WF-TASK-01's participation panel (Anyone tasks only; WEB-02 states R2): the turn of the day shown, "Take turns on this task"
 * (my `rota_consent`, online only, needing my enrolment), and "Turn order…" for whoever may edit the task's details.
 */
export function RotaPanel({
  row,
  canEditOrder,
  days,
  definition,
}: {
  row: RowModel;
  canEditOrder: boolean;
  /** The task's days this device holds (the detail's picker page), for the turns already set. */
  days: ReadonlyArray<{ id: string; data: OccurrenceData }>;
  definition: TaskDefinition | null;
}) {
  const env = useTasksEnv();
  const announcer = useAnnouncer();
  const names = useUsernames();
  const { rota, enrolled, reload } = useRota(row.taskId);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const consentKey = `${row.taskId}:consent`;
  const pending = attemptOf(env.identity, consentKey);
  const turn = row.data.rota;
  const state = rota.kind === "ready" ? rota.value : null;
  const consent = async (accepted: boolean, resend: boolean) => {
    if (state === null || busy) return;
    setBusy(true);
    setNote(null);
    const command: RotaConsentCommand = {
      kind: "rota_consent",
      task_id: row.taskId,
      expected_version: state.consent_version,
      accepted,
    };
    const out = await sendAccess(
      env,
      consentKey,
      resend && pending ? JSON.parse(pending.body) : command,
    );
    setBusy(false);
    if (out.kind === "ok") reload();
    else if (out.kind === "conflict") {
      setNote(ROTA_COPY.changed);
      reload();
    } else if (out.kind === "refused") setNote(ROTA_COPY.refused);
    else setNote(ROTA_COPY.uncertain);
    if (out.kind !== "ok" && out.kind !== "offline")
      announcer.announce(
        out.kind === "conflict" ? ROTA_COPY.changed : ROTA_COPY.uncertain,
        "assertive",
      );
  };
  const reason = !env.online
    ? ROTA_COPY.offline
    : !env.writable
      ? copy.NOT_WRITABLE
      : enrolled === false
        ? ROTA_COPY.join
        : busy
          ? ROTA_COPY.sending
          : state === null
            ? ROTA_COPY.loading
            : null;
  const checkboxId = useId();
  const reasonId = useId();
  return (
    <section className="flex flex-col gap-2" data-rota-panel={rota.kind}>
      {turn === undefined ? null : (
        <p
          className="text-[13px] text-ink-1"
          data-rota-turn={turn?.account_id ?? ""}
        >
          {ROTA_COPY.thisTurn(
            turn === null || turn.account_id === null
              ? ROTA_COPY.nobody
              : labelOf(turn.account_id, env.accountId, names, anonymous),
          )}
        </p>
      )}
      <label
        htmlFor={checkboxId}
        className="inline-flex min-h-11 items-center gap-2.5 text-[13.5px] text-ink-1"
      >
        <input
          id={checkboxId}
          type="checkbox"
          checked={state?.accepted ?? false}
          disabled={reason !== null}
          aria-describedby={reason !== null ? reasonId : undefined}
          onChange={(event) => void consent(event.target.checked, false)}
          className="size-[15px]"
          data-rota-consent=""
        />
        {ROTA_COPY.takeTurns}
      </label>
      {reason !== null ? (
        <span id={reasonId} className="text-[12px] text-ink-2">
          {reason}
        </span>
      ) : null}
      {note !== null ? (
        <p className="text-[12.5px] text-ink-2" data-rota-note="">
          {note}
        </p>
      ) : null}
      {pending !== null && note === ROTA_COPY.uncertain ? (
        <span>
          <Button onClick={() => void consent(state?.accepted ?? false, true)}>
            {copy.TRY_AGAIN}
          </Button>
        </span>
      ) : null}
      {rota.kind === "error" ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-ink-2">{ROTA_COPY.failed}</span>
          <Button variant="quiet" onClick={reload}>
            {copy.TRY_AGAIN}
          </Button>
        </span>
      ) : null}
      {canEditOrder ? (
        <span>
          {env.online && state !== null ? (
            <Button onClick={() => setOpen(true)}>{ROTA_COPY.order}</Button>
          ) : (
            <Button
              disabled
              reason={env.online ? ROTA_COPY.loading : ROTA_COPY.offline}
            >
              {ROTA_COPY.order}
            </Button>
          )}
        </span>
      ) : null}
      {open && state !== null && canEditOrder ? (
        <RotaDialog
          taskId={row.taskId}
          state={state}
          editor={canEditOrder}
          days={days}
          definition={definition}
          names={names}
          onClose={() => setOpen(false)}
          onSaved={reload}
        />
      ) : null}
    </section>
  );
}

/** WF-TASK-05: the turn order (CM-356; TASK-15/29/32), with what it gives. `set_rota`, online only, replaces the order. */
function RotaDialog({
  taskId,
  state,
  editor,
  days,
  definition,
  names,
  onClose,
  onSaved,
}: {
  taskId: string;
  state: RotaState;
  /**
   * The reader may edit the execution (review R7): the server then fills `eligible_participants`, so an EMPTY list is a known answer
   * (nobody has joined and agreed now) and every projected turn is left open. For any other reader the server withholds the list
   * (always empty), which says nothing: eligibility is then unknown.
   */
  editor: boolean;
  days: ReadonlyArray<{ id: string; data: OccurrenceData }>;
  definition: TaskDefinition | null;
  names: ReadonlyMap<string, string>;
  onClose(): void;
  onSaved(): void;
}) {
  const env = useTasksEnv();
  const announcer = useAnnouncer();
  const orderKey = `${taskId}:order`;
  // The unsaved order is kept for the screen's logical visit (WEB-10a decisions 44 and 48), against the version it was edited on.
  const input = useKeptInput<{ base: number; order: string[] }>(
    keptKey(env.identity, `rota:${taskId}`),
    env.identity,
    () => ({ base: state.version, order: [...state.participants] }),
    { consumed: () => null },
  );
  const [outcome, setOutcome] = useState<
    | null
    | { kind: "conflict" }
    | { kind: "refused"; requestId?: string }
    | { kind: "uncertain" }
  >(null);
  const label = (id: string) => labelOf(id, env.accountId, names, anonymous);
  // "Reload" after another editor's change: the order starts again from the latest saved one (the edit is never merged into it).
  const [reloading, setReloading] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: applied once the newer state has been read
  useEffect(() => {
    if (!reloading || state.version === input.value.base) return;
    setReloading(false);
    setOutcome(null);
    input.edit(() => ({ base: state.version, order: [...state.participants] }));
  }, [reloading, state.version]);
  const order = input.value.order;
  const saved =
    input.value.base === state.version &&
    order.length === state.participants.length &&
    order.every((id, i) => state.participants[i] === id);
  const candidates = state.eligible_participants.filter(
    (id) => !order.includes(id),
  );
  const turns = setTurns(days);
  const latest = turns[0]?.date ?? null;
  const upcoming =
    definition !== null && latest !== null
      ? nextDates(definition, latest, 4)
      : [];
  const projected = project({
    order,
    saved,
    ordinal: nextOrdinal(turns, state),
    count: upcoming.length,
    eligible: editor ? state.eligible_participants : null,
  });
  const save = async (resend: boolean) => {
    const ticket = input.submit();
    if (ticket === null) return;
    const command: SetRotaCommand = {
      kind: "set_rota",
      task_id: taskId,
      expected_version: input.value.base,
      participants: order,
    };
    const held = attemptOf(env.identity, orderKey);
    const out = await sendAccess(
      env,
      orderKey,
      resend && held ? JSON.parse(held.body) : command,
    );
    completeKept(ticket, out.kind === "ok");
    if (out.kind === "ok") {
      announcer.announce(ROTA_COPY.saved, "polite");
      onSaved();
      onClose();
      return;
    }
    setOutcome(
      out.kind === "conflict"
        ? { kind: "conflict" }
        : out.kind === "refused"
          ? {
              kind: "refused",
              ...(out.requestId ? { requestId: out.requestId } : {}),
            }
          : { kind: "uncertain" },
    );
  };
  const edit = (next: string[]) => {
    setOutcome(null);
    input.edit((v) => ({ ...v, order: next }));
  };
  const reason = !env.online
    ? ROTA_COPY.offline
    : !env.writable
      ? copy.NOT_WRITABLE
      : input.busy
        ? ROTA_COPY.sending
        : saved
          ? ROTA_COPY.nothingChanged
          : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={ROTA_COPY.title}
      description={ROTA_COPY.lead}
      footer={
        <div className="flex flex-col gap-2">
          {outcome?.kind === "conflict" ? (
            <span
              className="flex flex-wrap items-center gap-2"
              data-rota-conflict=""
            >
              <span className="text-[12.5px] text-ink-2">
                {ROTA_COPY.conflict}
              </span>
              <Button
                variant="quiet"
                onClick={() => {
                  setReloading(true);
                  onSaved();
                }}
              >
                {ROTA_COPY.reload}
              </Button>
            </span>
          ) : outcome?.kind === "refused" ? (
            <p className="text-[12.5px] text-ink-2" data-rota-refused="">
              {ROTA_COPY.refused}
              {outcome.requestId
                ? ` ${copy.REQUEST_ID(outcome.requestId)}`
                : ""}
            </p>
          ) : outcome?.kind === "uncertain" ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] text-ink-2">
                {ROTA_COPY.uncertain}
              </span>
              <Button variant="quiet" onClick={() => void save(true)}>
                {copy.TRY_AGAIN}
              </Button>
            </span>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="quiet" onClick={onClose}>
              {ROTA_COPY.cancel}
            </Button>
            {reason !== null ? (
              <Button disabled reason={reason}>
                {ROTA_COPY.save}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void save(false)}>
                {ROTA_COPY.save}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-rota-dialog="">
        <div className="flex flex-col gap-2">
          {order.length === 0 ? (
            <p className="text-[13px] text-ink-2">{ROTA_COPY.noTurns}</p>
          ) : (
            <ol
              className="m-0 flex list-none flex-col gap-1.5 p-0"
              data-rota-order=""
            >
              {order.map((id, i) => (
                <li
                  key={id}
                  data-rota-person={id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-row border border-hairline-strong bg-canvas px-3 py-1.5"
                >
                  <span className="flex items-center gap-2 text-[13.5px] text-ink-1">
                    <span
                      aria-hidden="true"
                      className="flex size-6 items-center justify-center rounded-full bg-inset text-[12px] text-ink-1"
                    >
                      {label(id).slice(0, 1)}
                    </span>
                    {i + 1}. {label(id)}
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {i === 0 ? (
                      <Button disabled reason={ROTA_COPY.first}>
                        {ROTA_COPY.up}
                      </Button>
                    ) : (
                      <Button
                        variant="quiet"
                        aria-label={`${ROTA_COPY.up}: ${label(id)}`}
                        onClick={() => edit(move(order, id, -1))}
                      >
                        {ROTA_COPY.up}
                      </Button>
                    )}
                    {i === order.length - 1 ? (
                      <Button disabled reason={ROTA_COPY.last}>
                        {ROTA_COPY.down}
                      </Button>
                    ) : (
                      <Button
                        variant="quiet"
                        aria-label={`${ROTA_COPY.down}: ${label(id)}`}
                        onClick={() => edit(move(order, id, 1))}
                      >
                        {ROTA_COPY.down}
                      </Button>
                    )}
                    <Button
                      variant="quiet"
                      aria-label={`${ROTA_COPY.remove}: ${label(id)}`}
                      onClick={() => edit(removeFrom(order, id))}
                    >
                      {ROTA_COPY.remove}
                    </Button>
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="text-[12px] text-ink-2" data-rota-count="">
            {ROTA_COPY.count(order.length)}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-[13.5px] font-medium text-ink-1">
            {ROTA_COPY.couldAdd}
          </h3>
          {state.eligible_participants.length === 0 ? (
            <p className="text-[12.5px] text-ink-2" data-rota-none-eligible="">
              {ROTA_COPY.noneEligible}
            </p>
          ) : candidates.length === 0 ? null : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {candidates.map((id) => (
                <li
                  key={id}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="text-[13px] text-ink-1">{label(id)}</span>
                  {order.length >= MAX_ROSTER ? (
                    <Button disabled reason={ROTA_COPY.count(order.length)}>
                      {ROTA_COPY.add}
                    </Button>
                  ) : (
                    <Button
                      aria-label={`${ROTA_COPY.add}: ${label(id)}`}
                      onClick={() => edit(addTo(order, id))}
                    >
                      {ROTA_COPY.add}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12px] text-ink-2">{ROTA_COPY.couldAddNote}</p>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-[13.5px] font-medium text-ink-1">
            {ROTA_COPY.gives}
          </h3>
          <table
            className="w-full text-left text-[13px] text-ink-1"
            data-rota-gives=""
          >
            <thead>
              <tr>
                <th className="py-1 font-medium">{ROTA_COPY.day}</th>
                <th className="py-1 font-medium">{ROTA_COPY.turn}</th>
              </tr>
            </thead>
            <tbody>
              {turns.slice(0, 4).map((t) => (
                <tr key={t.occurrenceId} data-rota-set={t.occurrenceId}>
                  <td className="py-1">{t.date ? dayLabel(t.date) : "—"}</td>
                  <td className="py-1">
                    {ROTA_COPY.alreadySet}:{" "}
                    {t.accountId === null
                      ? ROTA_COPY.leftOpen
                      : label(t.accountId)}
                  </td>
                </tr>
              ))}
              {upcoming.map((date, i) => {
                const p = projected[i];
                return (
                  <tr key={date} data-rota-projected={date}>
                    <td className="py-1">{dayLabel(date)}</td>
                    <td className="py-1">
                      {ROTA_COPY.projected}:{" "}
                      {p === undefined || p.kind === "none"
                        ? ROTA_COPY.noTurns
                        : p.kind === "open"
                          ? `${ROTA_COPY.leftOpen} (${label(p.accountId)})`
                          : label(p.accountId)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-[12px] text-ink-2">{ROTA_COPY.keepNote}</p>
          <p className="text-[12px] text-ink-2">{ROTA_COPY.accessNote}</p>
        </div>
      </div>
    </Dialog>
  );
}
