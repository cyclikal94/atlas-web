import { useNavigate } from "@tanstack/react-router";
import { type RefObject, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { useSharingDefaults } from "../../../data";
import type { SaveOutcome } from "../actions";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import {
  completeKept,
  disownKept,
  type KeptTicket,
  keptEntry,
  keptKey,
  useKeptInput,
} from "../kept-input";
import type { ComposedList } from "../model/list-view";
import {
  createList,
  editList,
  type ListNameProblem,
  listNameProblem,
  renameQueuedCreate,
} from "../model/lists";
import { type Evidence, type Issued, useListActions } from "./actions";
import { CREATE, DETAIL, NAME_PROBLEM, RENAME } from "./copy";

/**
 * The create and rename dialogs (plan §4.4-4.5). What is typed is an editing SESSION owned by the screen's visit (`kept-input.ts`,
 * `visit.ts`; WEB-10a decisions 49-50): the in-dialog sync control keeps it for the visit, and the dialog comes back with it, raw, when the
 * person returns; Escape, Cancel and the close icon discard it. Every save takes a ticket: its completion consumes the session only at the
 * revision it submitted (newer input stays, with a note), and closes or navigates only while the dialog still presents.
 *
 * A save whose outcome is not known (`SaveOutcome.uncertain`: it may have been stored) stays with the session as an unsettled ATTEMPT (R1,
 * D1): its exact request, ids and database. It is never sent again (revision 3, D1, approved 25 October 2026: a held id is no lifetime
 * guarantee, the draft that would recognise it can be discarded, replaced or cleaned up). Every later Save only LOOKS IT UP, read only
 * (`ListActions.reconcile`): found as it was sent, it is settled as the earlier request's success, and what was typed since stays, under
 * new ids, never consumed by it; otherwise (nothing under its id, a read that failed, another database, or a draft changed, refused or
 * discarded since) nothing is written, what was typed stays, and the dialog explains that the earlier outcome is unknown. Only a separate,
 * explicit decision ("Create as a new list", "Rename as a new change") starts a new change: new ids, and the defaults, policy version and
 * admission of now. It neither cancels nor proves the earlier save. What a save leaves in the session is part of its settlement
 * (`completeKept`'s one transition, revision 2): the dialog mounted when it settles shows it, whichever mount took the save.
 */
export const CREATE_EDITOR = "list-create";

/** Whether a kept editing session of `key` holds the person's input (its dialog is shown again when its screen is). */
export const holdsInput = (key: string): boolean => {
  const entry = keptEntry(key);
  return entry !== null && (entry.revision > 0 || entry.submitting !== null);
};
export const renameEditor = (listId: string) => `list-rename:${listId}`;

/**
 * An issued save of the session whose outcome is not known (D1): the name it saved and its exact request as sent (to recognise it, never
 * to send it again), its ids and the database it was issued to. `uncertain`: its answer was lost and it has not been looked up yet;
 * `unknown`: the last look found no exact evidence; `changed`: a draft under its id is not it as sent (edited, refused, discarded or
 * replaced). Ordinary Save only looks it up again; the person's separate decision (`again`) is the only way to a new change.
 */
interface Attempt extends Issued {
  name: string;
  announce: string;
  state: "uncertain" | Exclude<Evidence, "stored">;
}

/** Whether the session holds an earlier save this device could not settle: the person decides what happens next (D1). */
const undecided = (attempt: Attempt | null): attempt is Attempt =>
  attempt !== null && attempt.state !== "uncertain";

interface CreateInput {
  name: string;
  /** Chosen when the session opens, and anew after each save that may have been stored has been settled. */
  listId: string;
  localId: string;
  attempt: Attempt | null;
}

/**
 * What a save leaves in its session (R1), settled in ONE transition of the session (`completeKept`). Its success consumes the session at
 * the submitted revision (`detail`: the list a create made), else keeps what was typed since under new ids (`fresh`, allocated once: the
 * next save is a new list or rename). A save that may have been stored becomes the session's attempt, with the ids it used (`bind`); a
 * definite refusal leaves the session as it was (an earlier attempt stays as it is).
 */
function settleSave<T extends { attempt: Attempt | null }>(
  ticket: KeptTicket,
  sent: Attempt,
  outcome: SaveOutcome,
  fresh: (value: T) => T,
  bind: (value: T) => T,
  detail: string | null = null,
): void {
  if (outcome.ok) {
    completeKept<T>(ticket, true, {
      note: RENAME.newer,
      detail,
      change: (value) => ({ ...fresh(value), attempt: null }),
    });
    return;
  }
  const uncertain = outcome.uncertain === true;
  completeKept<T>(ticket, false, {
    note: outcome.message,
    change: (value) => (uncertain ? { ...bind(value), attempt: sent } : value),
  });
}

/**
 * An ordinary Save of a session holding an attempt only looks it up (D1): found as it was sent, it is settled as the earlier request's
 * success (`current`: it saved what the session shows, which is then consumed), and what was typed since stays, under new ids; otherwise
 * the session stays as it is, with the look's finding recorded on its attempt and explained. Nothing is ever sent.
 */
function settleLookup<T extends { attempt: Attempt | null }>(
  ticket: KeptTicket,
  attempt: Attempt,
  evidence: Evidence,
  current: boolean,
  notes: { newer: string; earlier: string; unknown: string; changed: string },
  fresh: (value: T) => T,
): void {
  if (evidence === "stored") {
    completeKept<T>(ticket, current, {
      note: current ? notes.newer : notes.earlier,
      change: (value) => ({ ...fresh(value), attempt: null }),
    });
    return;
  }
  completeKept<T>(ticket, false, {
    note: evidence === "unknown" ? notes.unknown : notes.changed,
    change: (value) =>
      value.attempt === attempt
        ? { ...value, attempt: { ...attempt, state: evidence } }
        : value,
  });
}

/** The person's decision on an earlier save this device could not settle (D1): a separate control, explained beside it. */
function Decision({
  label,
  note,
  writable,
  onDecide,
}: {
  label: string;
  note: string;
  writable: boolean;
  onDecide(): void;
}) {
  const explained = useId();
  return (
    <div className="flex flex-col items-start gap-2" data-list-decision="">
      <p id={explained} className="text-[12.5px] text-ink-2">
        {note}
      </p>
      {writable ? (
        <Button aria-describedby={explained} onClick={onDecide}>
          {label}
        </Button>
      ) : (
        <Button disabled reason={copy.NOT_WRITABLE}>
          {label}
        </Button>
      )}
    </div>
  );
}

function NameField({
  id,
  value,
  problem,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  problem: ListNameProblem | null;
  placeholder?: string;
  onChange(value: string): void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink-1">
        {CREATE.name}
      </label>
      <input
        id={id}
        value={value}
        data-field-edge=""
        data-list-name=""
        {...(placeholder ? { placeholder } : {})}
        {...(problem
          ? { "aria-invalid": true, "aria-describedby": `${id}-error` }
          : {})}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full rounded-control border border-field-edge bg-canvas px-3 text-[14px] text-ink-1 placeholder:text-ink-3"
      />
      {problem ? (
        <p id={`${id}-error`} className="text-[12px] text-conflict-text">
          {NAME_PROBLEM[problem]}
        </p>
      ) : null}
    </div>
  );
}

export function CreateListDialog({
  onClose,
  returnFocusRef,
}: {
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const env = useTasksEnv();
  const actions = useListActions();
  const announcer = useAnnouncer();
  // Mounting starts the defaults' read: the `list` defaults are captured at the act (D-10b-3).
  const defaults = useSharingDefaults();
  const navigate = useNavigate();
  const key = keptKey(env.identity, CREATE_EDITOR);
  const close = useRef(onClose);
  close.current = onClose;
  const kept = useKeptInput<CreateInput>(
    key,
    env.identity,
    () => ({
      name: "",
      listId: env.newId(),
      localId: env.newId(),
      attempt: null,
    }),
    {
      // Told only while the dialog presents: it closes onto the new list, shown projected ("Not sent yet").
      consumed: (value, made) => {
        close.current();
        void navigate({
          to: "/tasks/lists/$listId",
          params: { listId: made ?? value.listId },
        });
        return null;
      },
    },
  );
  const [problem, setProblem] = useState<ListNameProblem | null>(null);
  const field = useId();
  const discard = () => disownKept(key);
  /** `again`: the person's decision to start a new change after an earlier save this device could not settle (D1). */
  const save = async (again = false) => {
    if (kept.busy) return;
    const { name, listId, localId, attempt } = kept.value;
    const found = listNameProblem(name);
    setProblem(found);
    if (found !== null) return;
    if (again && !undecided(attempt)) return;
    const ticket = kept.submit();
    if (ticket === null) return;
    if (attempt !== null && !again) {
      // Looked up, never sent again (D1).
      let evidence: Evidence = "unknown";
      try {
        evidence = await actions.reconcile(attempt);
      } finally {
        const notes = {
          newer: RENAME.newer,
          earlier: CREATE.earlier(attempt.name),
          unknown: CREATE.unknown(attempt.name),
          changed: CREATE.changed(attempt.name),
        };
        announcer.announce(
          evidence === "stored"
            ? attempt.announce
            : evidence === "unknown"
              ? notes.unknown
              : notes.changed,
          evidence === "stored" ? "polite" : "assertive",
        );
        settleLookup<CreateInput>(
          ticket,
          attempt,
          evidence,
          attempt.name === name,
          notes,
          (value) => ({ ...value, listId: env.newId(), localId: env.newId() }),
        );
      }
      return;
    }
    // A new change has new ids and the defaults of now (D-10b-3), never the earlier save's.
    const ids = again
      ? { listId: env.newId(), localId: env.newId() }
      : { listId, localId };
    const sent: Attempt = {
      name,
      localId: ids.localId,
      request: createList({
        listId: ids.listId,
        name,
        defaults: defaults.record,
        localId: ids.localId,
      }),
      scope: actions.scope(),
      announce: defaults.record === null ? CREATE.reviewNeeded : CREATE.saved,
      state: "uncertain",
    };
    let outcome: SaveOutcome = { ok: false, message: null };
    try {
      outcome = await actions.enqueue(sent.request, sent.announce);
    } finally {
      settleSave<CreateInput>(
        ticket,
        sent,
        outcome,
        (value) => ({ ...value, listId: env.newId(), localId: env.newId() }),
        (value) => ({ ...value, ...ids }),
        ids.listId,
      );
    }
  };
  const attempt = kept.value.attempt;
  return (
    <Dialog
      open
      onClose={onClose}
      onDiscard={discard}
      title={CREATE.title}
      initialFocusSelector="[data-list-name]"
      {...(returnFocusRef ? { returnFocusRef } : {})}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="quiet"
            onClick={() => {
              discard();
              onClose();
            }}
          >
            {CREATE.cancel}
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            {CREATE.submit}
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-3"
        data-list-create=""
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={kept.busy} className="flex flex-col gap-3">
          <NameField
            id={field}
            value={kept.value.name}
            problem={problem}
            placeholder={CREATE.placeholder}
            onChange={(name) => kept.edit((v) => ({ ...v, name }))}
          />
          <p className="text-[12px] text-ink-2">{CREATE.caption}</p>
        </fieldset>
        {kept.note ? (
          <p className="text-[12.5px] text-ink-2" data-list-note="">
            {kept.note}
          </p>
        ) : null}
        {undecided(attempt) ? (
          <Decision
            label={CREATE.again}
            note={CREATE.againNote}
            writable={env.writable}
            onDecide={() => void save(true)}
          />
        ) : null}
      </form>
    </Dialog>
  );
}

interface RenameInput {
  name: string;
  localId: string;
  /** A rename of the cached list whose outcome is not known (R1, D1). */
  attempt: Attempt | null;
  /**
   * The list's queued create as the person first saw it (its digest), kept with the session through a sync visit: a rename edits that
   * create only while it is still that one, so another tab's newer edit is never overwritten from this dialog, even after a re-read.
   */
  seen: string | null;
}

/**
 * Rename (§4.5, D-10b-8). The path is chosen at the act from the latest certified read: the list's queued create is edited in place;
 * a cached list is renamed with `edit_list` on its policy version (Q1); otherwise (its create sent, the list not received yet) there is
 * no policy version to send, and the reason is shown. A list gone while the dialog is open keeps what was typed and saves nothing.
 */
export function RenameListDialog({
  listId,
  list,
  onClose,
  returnFocusRef,
}: {
  listId: string;
  /** The latest complete read of the list (null: this device no longer holds it). */
  list: ComposedList | null;
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const env = useTasksEnv();
  const actions = useListActions();
  const announcer = useAnnouncer();
  const key = keptKey(env.identity, renameEditor(listId));
  const close = useRef(onClose);
  close.current = onClose;
  const latest = useRef(list);
  latest.current = list;
  const kept = useKeptInput<RenameInput>(
    key,
    env.identity,
    () => ({
      name: list?.row.label ?? "",
      localId: env.newId(),
      seen:
        list?.create?.status === "queued" ? list.create.command_digest : null,
      attempt: null,
    }),
    {
      consumed: () => {
        close.current();
        return null;
      },
    },
  );
  const [problem, setProblem] = useState<ListNameProblem | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const field = useId();
  const discard = () => disownKept(key);
  const queuedCreate = list?.create?.status === "queued" ? list.create : null;
  const policyVersion = list?.projected ? undefined : list?.row.policy_version;
  const path: "queued" | "edit" | "wait" | "gone" | "denied" =
    list === null
      ? "gone"
      : !list.row.can_edit
        ? "denied"
        : queuedCreate !== null
          ? "queued"
          : policyVersion !== undefined
            ? "edit"
            : "wait";
  const nameProblem = listNameProblem(kept.value.name);
  // An unsettled rename can always be looked up again (it may show already, as the list's queued name).
  const changed =
    list !== null &&
    (kept.value.name !== list.row.label || kept.value.attempt !== null);
  /** `again`: the person's decision to start a new change after an earlier rename this device could not settle (D1). */
  const save = async (again = false) => {
    if (kept.busy) return;
    // Every route into a save is admitted by the LATEST read, not only by the button's state.
    const now = latest.current;
    const { name, localId, attempt } = kept.value;
    if (now === null) {
      setRefusal(RENAME.gone);
      return;
    }
    const found = listNameProblem(name);
    setProblem(found);
    if (found !== null) return;
    if (again && !undecided(attempt)) return;
    if (attempt !== null && !again) {
      // Looked up, never sent again (D1).
      setRefusal(null);
      const ticket = kept.submit();
      if (ticket === null) return;
      let evidence: Evidence = "unknown";
      try {
        evidence = await actions.reconcile(attempt);
      } finally {
        const notes = {
          newer: RENAME.newer,
          earlier: RENAME.earlier(attempt.name),
          unknown: RENAME.unknown(attempt.name),
          changed: RENAME.changed(attempt.name),
        };
        announcer.announce(
          evidence === "stored"
            ? attempt.announce
            : evidence === "unknown"
              ? notes.unknown
              : notes.changed,
          evidence === "stored" ? "polite" : "assertive",
        );
        settleLookup<RenameInput>(
          ticket,
          attempt,
          evidence,
          attempt.name === name,
          notes,
          (value) => ({ ...value, localId: env.newId(), seen: null }),
        );
      }
      return;
    }
    if (!now.row.can_edit) {
      setRefusal(actions.denied().message);
      return;
    }
    const create = now.create?.status === "queued" ? now.create : null;
    if (
      create !== null &&
      kept.value.seen !== null &&
      create.command_digest !== kept.value.seen
    ) {
      // Edited elsewhere since this dialog opened: what was typed stays; the next Save is the person's decision on what is there now.
      const digest = create.command_digest;
      kept.edit((value) => ({ ...value, seen: digest }));
      setRefusal(RENAME.changedElsewhere);
      return;
    }
    if (again && name === now.row.label) {
      setRefusal(RENAME.unchanged);
      return;
    }
    // A new change has a new id and the policy version of now (Q1), never the earlier rename's.
    const id = again ? env.newId() : localId;
    const version = now.projected ? undefined : now.row.policy_version;
    const request =
      create !== null
        ? renameQueuedCreate(create, name)
        : version !== undefined
          ? editList({ listId, name, policyVersion: version, localId: id })
          : null;
    if (request === null) {
      setRefusal(RENAME.waitSync);
      return;
    }
    setRefusal(null);
    const ticket = kept.submit();
    if (ticket === null) return;
    const sent: Attempt = {
      name,
      localId: id,
      request,
      scope: actions.scope(),
      announce: RENAME.saved,
      state: "uncertain",
    };
    let outcome: SaveOutcome = { ok: false, message: null };
    try {
      // An in-place edit of the queued create writes the whole name again and is never `uncertain` here: a retry of it is built anew.
      outcome =
        create !== null
          ? await actions.editQueued(create.local_id, request, RENAME.saved)
          : await actions.enqueue(request, sent.announce);
    } finally {
      settleSave<RenameInput>(
        ticket,
        sent,
        outcome,
        (value) => ({ ...value, localId: env.newId(), seen: null }),
        (value) => ({ ...value, localId: id }),
      );
    }
  };
  const blocked =
    path === "gone"
      ? RENAME.gone
      : path === "denied"
        ? DETAIL.noEdit
        : path === "wait"
          ? RENAME.waitSync
          : null;
  return (
    <Dialog
      open
      onClose={onClose}
      onDiscard={discard}
      title={RENAME.title}
      initialFocusSelector="[data-list-name]"
      {...(returnFocusRef ? { returnFocusRef } : {})}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="quiet"
            onClick={() => {
              discard();
              onClose();
            }}
          >
            {RENAME.cancel}
          </Button>
          {blocked !== null ||
          !env.writable ||
          nameProblem !== null ||
          !changed ? (
            <Button
              variant="primary"
              disabled
              reason={
                blocked ??
                (!env.writable
                  ? copy.NOT_WRITABLE
                  : nameProblem !== null
                    ? NAME_PROBLEM[nameProblem]
                    : RENAME.unchanged)
              }
            >
              {RENAME.submit}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void save()}>
              {RENAME.submit}
            </Button>
          )}
        </div>
      }
    >
      <form
        className="flex flex-col gap-3"
        data-list-rename={path}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={kept.busy} className="flex flex-col gap-3">
          <NameField
            id={field}
            value={kept.value.name}
            problem={problem}
            onChange={(name) => kept.edit((v) => ({ ...v, name }))}
          />
        </fieldset>
        {(refusal ?? kept.note) ? (
          <p className="text-[12.5px] text-ink-2" data-list-note="">
            {refusal ?? kept.note}
          </p>
        ) : null}
        {undecided(kept.value.attempt) && blocked === null ? (
          <Decision
            label={RENAME.again}
            note={RENAME.againNote}
            writable={env.writable}
            onDecide={() => void save(true)}
          />
        ) : null}
      </form>
    </Dialog>
  );
}
