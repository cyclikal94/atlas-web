import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { useSharingDefaults } from "../../../data";
import { firstControl, openingFocus } from "../../../lib/form-recovery/focus";
import { RecoveryNotice } from "../../../lib/form-recovery/RecoveryNotice";
import type { RotaConsentCommand, SetRotaCommand, TasksResult } from "../api";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { dayLabel } from "../format";
import {
  completeKept,
  type KeptRecovery,
  type KeptTicket,
  keptKey,
  useKeptInput,
  useKeptRecovery,
} from "../kept-input";
import {
  dismissRota,
  noteIfRefused,
  type RotaAttempt,
  type RotaHold,
  type RotaOrigin,
  type RotaOutcome,
  rotaHoldOf,
  rotaReadsOf,
  rotaSerial,
  settleRota,
  startRota,
  subscribeRota,
} from "../memory";
import type {
  OccurrenceData,
  RotaState,
  TaskDefinition,
  TaskResult,
} from "../model/contract";
import { rotaFormContext } from "../model/recovery";
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
import { useOpenOnRestore } from "./restore-once";

/** Provisional copy (STAGED-ACCEPTANCE-20261011; docs/tasks.md WEB-10c checkpoint list). */
export const ROTA_COPY = {
  heading: "Turns",
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
  savedEarlier:
    "Your earlier order was saved. Your newer changes aren't saved yet.",
  nothingChanged: "Nothing has changed",
  you: "You",
} as const;

// ---- app-update recovery of the turn order (WEB-14a maintenance merge of accepted WEB-10c, D-1) ----------------------------------------
interface OrderInput {
  base: number;
  order: string[];
}

/** The kept session of one task's turn order. */
export const rotaEditor = (taskId: string) => `rota:${taskId}`;

/**
 * The turn order's recoverable input (Q4; the task editors' protocol, `kept-input.ts` revision 37): the order as the person left it and the
 * roster version it was edited on (`base`, as the sharing editor keeps the version it was composed against), as explicitly versioned JSON
 * under the task's context. Restoring never saves: Save sends `expected_version: base`, so an order edited on a version someone has since
 * changed meets the server's conflict and its "Reload", exactly as it would have without the reload. A text this build cannot read
 * restores nothing.
 */
export const rotaRecovery = (taskId: string): KeptRecovery<OrderInput> => ({
  context: rotaFormContext(taskId),
  encode: (value) =>
    JSON.stringify({ v: 1, base: value.base, order: value.order }),
  decode: (text) => {
    try {
      const raw = JSON.parse(text) as Record<string, unknown> | null;
      if (raw === null || typeof raw !== "object" || raw.v !== 1) return null;
      const { base, order } = raw;
      if (typeof base !== "number" || !Number.isInteger(base) || base < 0)
        return null;
      if (!Array.isArray(order) || order.length > MAX_ROSTER) return null;
      if (!order.every((id): id is string => typeof id === "string"))
        return null;
      if (new Set(order).size !== order.length) return null;
      return { base, order: [...order] };
    } catch {
      return null;
    }
  },
});

// ---- page memory: one attempt per body (D-10c-9; WEB-10a `model/attempt.ts`), held and settled by `memory.ts` (review 8, R33) ----------
/** The request on its way for each pending attempt: the same change asked again while it is pending joins it (never a second flight). */
const flights = new WeakMap<RotaAttempt, Promise<Send>>();

/** What the page holds for `command` now, as every screen showing it is told (whichever screen sent the change). */
function useRotaHold(identity: string, command: string): RotaHold {
  const hold = () => rotaHoldOf(identity, command);
  return useSyncExternalStore(subscribeRota, hold, hold);
}

/**
 * Whether a save's ticket is the input its sent change was made from (review 9, R34): the same editor, session and revision. Save sends
 * what its ticket holds, so it always is; Try again sends the held attempt's body, which is the input only if nothing was edited since
 * that change was saved (an edit away and back is still an edit).
 */
const represents = (origin: RotaOrigin | null, ticket: KeptTicket): boolean =>
  origin !== null &&
  origin.editor === ticket.key &&
  origin.session === ticket.session &&
  origin.revision === ticket.revision;

/** The outcome a screen mounted at serial `since` shows: one settled after it mounted (an earlier screen's own note is not carried over). */
const shownSince = (hold: RotaHold, since: number): RotaOutcome | null =>
  hold.outcome !== null && hold.outcome.serial > since ? hold.outcome : null;

type Send =
  | { kind: "ok" }
  | { kind: "conflict" }
  | { kind: "refused"; requestId?: string }
  | { kind: "uncertain" }
  | { kind: "not_sent" };

/**
 * One online-only access command, one attempt per canonical body: an uncertain answer keeps the attempt (its key and body), so "Try again"
 * resends exactly that; a definite answer ends it, and the next change is a new key. Offline or not writable, nothing is sent (the screens
 * say why), Try again included.
 *
 * Review 8, R33: the answer settles only ITS attempt (`settleRota`): a change sent after the person went away and came back, while this one
 * was still on its way, is a new attempt, and this one's late answer, whatever it is, leaves it held with its own body and key. `reread`:
 * the answers after which the rota is read again (by the screen showing it then). `origin`: the editor input `command` was made from
 * (review 9, R34), kept with the attempt.
 */
async function sendAccess(
  env: ReturnType<typeof useTasksEnv>,
  taskId: string,
  memoryKey: string,
  command: SetRotaCommand | RotaConsentCommand,
  reread: ReadonlyArray<Send["kind"]>,
  origin: RotaOrigin | null = null,
): Promise<Send> {
  if (!env.online || !env.writable) return { kind: "not_sent" };
  const identity = env.identity;
  const { attempt, joined } = startRota(
    identity,
    memoryKey,
    command,
    env.newId,
    origin,
  );
  const flying = joined ? flights.get(attempt) : undefined;
  if (flying !== undefined) return flying;
  const flight = env.api
    .access(JSON.parse(attempt.body), attempt.key)
    .then((result: TasksResult<TaskResult>): Send => {
      const out = sendOf(result);
      settleRota(
        identity,
        memoryKey,
        attempt,
        out.kind === "ok"
          ? { kind: "saved" }
          : (out as { kind: RotaOutcome["kind"]; requestId?: string }),
        reread.includes(out.kind) ? taskId : null,
      );
      return out;
    });
  flights.set(attempt, flight);
  return flight;
}

function sendOf(result: TasksResult<TaskResult>): Send {
  if (result.ok) return { kind: "ok" };
  switch (result.kind) {
    case "uncertain":
    case "not_sent":
    case "closed":
    case "offline":
      return { kind: "uncertain" };
    case "conflict":
    case "operation_conflict":
      return { kind: "conflict" };
    default:
      return {
        kind: "refused",
        ...(result.requestId ? { requestId: result.requestId } : {}),
      };
  }
}

/**
 * The rota of the task (`GET /tasks/{id}/rota`) and whether I take part now (`GET /tasks/{id}/enrolment`), online, per identity.
 * Exported for its hook-level identity test (the screens remount on another identity, which hides this hook's own rule).
 *
 * ONE read owns what this shows (review R18): the pair asked last. Asking again (`reload`, a reconnect, another identity or task) and
 * going offline or unmounting move the owner at once, so an earlier pair's answer, success or failure, never replaces a later one's
 * roster, consent or enrolment, even for the same identity and task. A refusal is still noted for the page whatever the owner
 * (`noteIfRefused`: the protected tree must not loop on it).
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
  const owner = useRef(0);
  const [asked, setAsked] = useState(0);
  // A rota change answered so that the rota changed asks again too, whichever screen sent it (review 8, R33: `settleRota`'s `reread`).
  const reads = () => rotaReadsOf(env.identity, taskId);
  const again = asked + useSyncExternalStore(subscribeRota, reads, reads);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again for another identity, the connection or a change made
  useEffect(() => {
    owner.current += 1;
    const mine = owner.current;
    if (!env.online) {
      setState({ scope, rota: { kind: "offline" }, enrolled: null });
      return;
    }
    void Promise.all([
      env.api.readRota(taskId),
      env.api.readEnrolment(taskId),
    ]).then(([rota, enrolment]) => {
      noteIfRefused(env.identity, `rota:${taskId}`, rota);
      noteIfRefused(env.identity, `enrolment:${taskId}`, enrolment);
      // Only the pair asked last is shown (CM-384 for another identity or task; review R18 for the same one).
      if (owner.current !== mine) return;
      setState({
        scope,
        rota: rota.ok
          ? { kind: "ready", value: rota.value }
          : { kind: "error" },
        enrolled: enrolment.ok ? enrolment.value.active : null,
      });
    });
    return () => {
      owner.current += 1;
    };
  }, [scope, env.online, again]);
  const value = state.scope === scope ? state : null;
  return {
    rota: value?.rota ?? { kind: "loading" as const },
    enrolled: value?.enrolled ?? null,
    reload: () => {
      // The pair on its way is no longer the one asked for, even before the next read begins.
      owner.current += 1;
      setAsked((n) => n + 1);
    },
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
  // Taken synchronously: a second activation in the same turn sends nothing.
  const flying = useRef(false);
  const [open, setOpen] = useState(false);
  const consentKey = `${row.taskId}:consent`;
  // D-1 (WEB-14a maintenance merge): the dialog is not open after an app-update reload, so the panel looks for the order the page before
  // it left and opens the dialog on it (restored, never saved), once the rota is read and only for whoever may still edit the order.
  const orderEditor = keptKey(env.identity, rotaEditor(row.taskId));
  const look = useKeptRecovery(
    orderEditor,
    env.identity,
    rotaRecovery(row.taskId),
    () => ({ base: 0, order: [] }),
    false,
  );
  // The consent and the order as the page holds them (review 8, R33): this panel shows and announces what was answered since it mounted,
  // whichever mount sent it; an earlier change's late answer settles nothing of a later one.
  const consentHold = useRotaHold(env.identity, consentKey);
  const orderHold = useRotaHold(env.identity, `${row.taskId}:order`);
  const since = useRef(rotaSerial());
  const announced = useRef(since.current);
  const said = shownSince(consentHold, since.current);
  const pending =
    consentHold.attempt?.phase === "uncertain" ? consentHold.attempt : null;
  const note =
    said === null
      ? null
      : said.kind === "conflict"
        ? ROTA_COPY.changed
        : said.kind === "refused"
          ? ROTA_COPY.refused
          : said.kind === "uncertain"
            ? ROTA_COPY.uncertain
            : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: announced once per outcome settled while this panel is mounted
  useEffect(() => {
    for (const [said, of] of [
      [consentHold.outcome, "consent"],
      [orderHold.outcome, "order"],
    ] as const) {
      if (said === null || said.serial <= announced.current) continue;
      announced.current = Math.max(announced.current, said.serial);
      if (of === "order") {
        if (said.kind === "saved")
          announcer.announce(ROTA_COPY.saved, "polite");
      } else if (said.kind !== "saved")
        announcer.announce(
          said.kind === "conflict" ? ROTA_COPY.changed : ROTA_COPY.uncertain,
          "assertive",
        );
    }
  }, [consentHold.outcome, orderHold.outcome]);
  const turn = row.data.rota;
  const state = rota.kind === "ready" ? rota.value : null;
  useOpenOnRestore(
    look,
    orderEditor,
    !open && state !== null && canEditOrder,
    () => setOpen(true),
  );
  const consent = async (accepted: boolean, resend: boolean) => {
    if (state === null || flying.current) return;
    // Try again resends the change held uncertain NOW, or nothing (one answered meanwhile is not sent again as another change).
    const held = rotaHoldOf(env.identity, consentKey).attempt;
    if (resend && held?.phase !== "uncertain") return;
    flying.current = true;
    setBusy(true);
    const command: RotaConsentCommand = {
      kind: "rota_consent",
      task_id: row.taskId,
      expected_version: state.consent_version,
      accepted,
    };
    // The rota is read again after a success or a conflict (`settleRota`), by the panel showing it then.
    await sendAccess(
      env,
      row.taskId,
      consentKey,
      resend && held ? JSON.parse(held.body) : command,
      ["ok", "conflict"],
    );
    flying.current = false;
    setBusy(false);
  };
  const blocked = !env.online
    ? ROTA_COPY.offline
    : !env.writable
      ? copy.NOT_WRITABLE
      : null;
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
          className="text-sm text-foreground"
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
        className="inline-flex min-h-11 items-center gap-2.5 text-sm text-foreground"
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
        <span id={reasonId} className="text-xs text-muted-foreground">
          {reason}
        </span>
      ) : null}
      {note !== null ? (
        <p className="text-xs text-muted-foreground" data-rota-note="">
          {note}
        </p>
      ) : null}
      {pending !== null && note === ROTA_COPY.uncertain ? (
        <span>
          {blocked !== null ? (
            <Button disabled reason={blocked}>
              {copy.TRY_AGAIN}
            </Button>
          ) : (
            <Button
              onClick={() => void consent(state?.accepted ?? false, true)}
            >
              {copy.TRY_AGAIN}
            </Button>
          )}
        </span>
      ) : null}
      {rota.kind === "error" ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {ROTA_COPY.failed}
          </span>
          <Button variant="ghost" onClick={reload}>
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
  const orderKey = `${taskId}:order`;
  // The unsaved order is kept for the screen's logical visit (WEB-10a decisions 44 and 48), against the version it was edited on. A save
  // that consumed it closes the dialog only if it is the one the person is at now (`useKeptInput`: an earlier dialog's answer, the person
  // gone and back meanwhile, closes nothing; review 8, R33).
  // D-1 (WEB-14a maintenance merge): recoverable around an app-update reload (Q4), for exactly this task's order.
  const input = useKeptInput<OrderInput>(
    keptKey(env.identity, rotaEditor(taskId)),
    env.identity,
    () => ({ base: state.version, order: [...state.participants] }),
    {
      consumed: () => {
        onClose();
        return null;
      },
      recover: rotaRecovery(taskId),
    },
  );
  // The restored dialog's first field: the first control of the ORDER that can be used (a move or a remove), else of the people who could
  // be added (an add), read in those two sections only, which never hold the recovery notice (revision 57, Review 57 F-R57-1; design
  // assessment C-F1: the notice's own "Discard instead" was the first enabled button of the dialog's body). With neither, the dialog's own
  // opening focus (decision D1). The restored arrival, a copy chosen and a keyboard discard's return all use it (I-F2).
  const body = useRef<HTMLDivElement>(null);
  const orderSection = useRef<HTMLDivElement>(null);
  const addSection = useRef<HTMLDivElement>(null);
  const firstField = () =>
    firstControl(orderSection.current) ??
    firstControl(addSection.current) ??
    openingFocus(body.current);
  // What the order's change was answered, as the page holds it, since this dialog opened (an edit or a reload puts it away).
  const hold = useRotaHold(env.identity, orderKey);
  const since = useRef(rotaSerial());
  const said = shownSince(hold, since.current);
  const outcome =
    said === null
      ? null
      : said.kind === "saved"
        ? // Still open after a save it answered: the person had edited past what was saved (the newer order stays, unsaved; R34).
          { kind: "saved" as const }
        : said.kind === "refused"
          ? {
              kind: "refused" as const,
              ...(said.requestId ? { requestId: said.requestId } : {}),
            }
          : { kind: said.kind };
  const label = (id: string) => labelOf(id, env.accountId, names, anonymous);
  // "Reload" after another editor's change: the order starts again from the latest saved one (the edit is never merged into it).
  const [reloading, setReloading] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: applied once the newer state has been read
  useEffect(() => {
    if (!reloading || state.version === input.value.base) return;
    setReloading(false);
    dismissRota(env.identity, orderKey);
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
    // Try again resends the change held uncertain NOW, or nothing.
    const held = rotaHoldOf(env.identity, orderKey).attempt;
    if (resend && held?.phase !== "uncertain") return;
    const ticket = input.submit();
    if (ticket === null) return;
    const command: SetRotaCommand = {
      kind: "set_rota",
      task_id: taskId,
      expected_version: input.value.base,
      participants: order,
    };
    // The input the change sent represents (review 9, R34), taken with its body before anything is awaited: Save's own ticket; Try
    // again's, the held attempt's (its body is that earlier save's, whatever the editor holds now).
    const origin: RotaOrigin | null =
      resend && held
        ? held.origin
        : {
            editor: ticket.key,
            session: ticket.session,
            revision: ticket.revision,
          };
    // A success reads the rota again and is announced by the panel; it consumes the order only if this ticket is the input the change was
    // made from (closing the dialog, above). Otherwise the flight ends and the newer order stays, unsaved.
    const out = await sendAccess(
      env,
      taskId,
      orderKey,
      resend && held ? JSON.parse(held.body) : command,
      ["ok"],
      origin,
    );
    completeKept(ticket, out.kind === "ok" && represents(origin, ticket));
  };
  const edit = (next: string[]) => {
    dismissRota(env.identity, orderKey);
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
          {outcome?.kind === "saved" ? (
            <p
              className="text-xs text-muted-foreground"
              data-rota-saved-earlier=""
            >
              {ROTA_COPY.savedEarlier}
            </p>
          ) : outcome?.kind === "conflict" ? (
            <span
              className="flex flex-wrap items-center gap-2"
              data-rota-conflict=""
            >
              <span className="text-xs text-muted-foreground">
                {ROTA_COPY.conflict}
              </span>
              <Button
                variant="ghost"
                onClick={() => {
                  setReloading(true);
                  onSaved();
                }}
              >
                {ROTA_COPY.reload}
              </Button>
            </span>
          ) : outcome?.kind === "refused" ? (
            <p className="text-xs text-muted-foreground" data-rota-refused="">
              {ROTA_COPY.refused}
              {outcome.requestId
                ? ` ${copy.REQUEST_ID(outcome.requestId)}`
                : ""}
            </p>
          ) : outcome?.kind === "uncertain" ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {ROTA_COPY.uncertain}
              </span>
              {hold.attempt?.phase !== "uncertain" ? null : !env.writable ? (
                <Button disabled reason={copy.NOT_WRITABLE}>
                  {copy.TRY_AGAIN}
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => void save(true)}>
                  {copy.TRY_AGAIN}
                </Button>
              )}
            </span>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {ROTA_COPY.cancel}
            </Button>
            {reason !== null ? (
              <Button disabled reason={reason}>
                {ROTA_COPY.save}
              </Button>
            ) : (
              <Button variant="default" onClick={() => void save(false)}>
                {ROTA_COPY.save}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div ref={body} className="flex flex-col gap-4" data-rota-dialog="">
        {input.recovery ? (
          <RecoveryNotice
            recovery={input.recovery}
            firstFieldRef={firstField}
          />
        ) : null}
        <div
          ref={orderSection}
          className="flex flex-col gap-2"
          data-rota-editor=""
        >
          {order.length === 0 ? (
            <p className="text-sm text-muted-foreground">{ROTA_COPY.noTurns}</p>
          ) : (
            <ol
              className="m-0 flex list-none flex-col gap-1.5 p-0"
              data-rota-order=""
            >
              {order.map((id, i) => (
                <li
                  key={id}
                  data-rota-person={id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-1.5"
                >
                  <span className="flex items-center gap-2 text-sm text-foreground">
                    <span
                      aria-hidden="true"
                      className="flex size-6 items-center justify-center rounded-full bg-muted text-xs text-foreground"
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
                        variant="ghost"
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
                        variant="ghost"
                        aria-label={`${ROTA_COPY.down}: ${label(id)}`}
                        onClick={() => edit(move(order, id, 1))}
                      >
                        {ROTA_COPY.down}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
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
          <p className="text-xs text-muted-foreground" data-rota-count="">
            {ROTA_COPY.count(order.length)}
          </p>
        </div>
        <div
          ref={addSection}
          className="flex flex-col gap-2"
          data-rota-editor=""
        >
          <h3 className="text-sm font-medium text-foreground">
            {ROTA_COPY.couldAdd}
          </h3>
          {state.eligible_participants.length === 0 ? (
            <p
              className="text-xs text-muted-foreground"
              data-rota-none-eligible=""
            >
              {ROTA_COPY.noneEligible}
            </p>
          ) : candidates.length === 0 ? null : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {candidates.map((id) => (
                <li
                  key={id}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="text-sm text-foreground">{label(id)}</span>
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
          <p className="text-xs text-muted-foreground">
            {ROTA_COPY.couldAddNote}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-foreground">
            {ROTA_COPY.gives}
          </h3>
          <table
            className="w-full text-left text-sm text-foreground"
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
          <p className="text-xs text-muted-foreground">{ROTA_COPY.keepNote}</p>
          <p className="text-xs text-muted-foreground">
            {ROTA_COPY.accessNote}
          </p>
        </div>
      </div>
    </Dialog>
  );
}
