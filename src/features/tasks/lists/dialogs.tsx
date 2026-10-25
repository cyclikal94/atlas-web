import { useNavigate } from "@tanstack/react-router";
import { type RefObject, useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { type EnqueueRequest, useSharingDefaults } from "../../../data";
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
import { useListActions } from "./actions";
import { CREATE, DETAIL, NAME_PROBLEM, RENAME } from "./copy";

/**
 * The create and rename dialogs (plan §4.4-4.5). What is typed is an editing SESSION owned by the screen's visit (`kept-input.ts`,
 * `visit.ts`; WEB-10a decisions 49-50): the in-dialog sync control keeps it for the visit, and the dialog comes back with it, raw, when the
 * person returns; Escape, Cancel and the close icon discard it. Every save takes a ticket: its completion consumes the session only at the
 * revision it submitted (newer input stays, with a note), and closes or navigates only while the dialog still presents.
 *
 * A save whose outcome is not known (`SaveOutcome.uncertain`: it may have been stored) binds the session's local id to that exact request
 * (R1): every later Save sends it again, unchanged, until it is saved (the outbox recognises a stored one: never a second list or rename).
 * Only then is what the person typed since saved, by a new Save under new ids; it is never consumed by the earlier request's success.
 * What a save leaves in the session (its request bound, or new ids) is part of its settlement (`completeKept`'s one transition, revision
 * 2): the dialog mounted when it settles shows it, whichever mount took the save, so the next Save acts on what the person sees.
 */
export const CREATE_EDITOR = "list-create";

/** Whether a kept editing session of `key` holds the person's input (its dialog is shown again when its screen is). */
export const holdsInput = (key: string): boolean => {
  const entry = keptEntry(key);
  return entry !== null && (entry.revision > 0 || entry.submitting !== null);
};
export const renameEditor = (listId: string) => `list-rename:${listId}`;

/** A save of the session whose outcome is not known: the name it saved and its exact request, sent again as it is. */
interface Unsettled {
  name: string;
  request: EnqueueRequest;
  announce: string;
}

interface CreateInput {
  name: string;
  /** Chosen when the session opens: a retry after an uncertain save reuses them (`duplicate`, never a second list). */
  listId: string;
  localId: string;
  unsettled: Unsettled | null;
}

/**
 * What a save leaves in its session (R1), settled in ONE transition of the session (`completeKept`). A success of what the session shows
 * consumes it at the submitted revision; a success of an earlier, unsettled request settles that request and keeps what was typed since,
 * under new ids (`fresh`, allocated once: the next save is a new list or rename, not a duplicate). A save that may have been stored binds
 * the session to its request; a definite refusal leaves the session as it was.
 */
function settleSave<T extends { unsettled: Unsettled | null }>(
  ticket: KeptTicket,
  sent: Unsettled,
  current: boolean,
  outcome: SaveOutcome,
  notes: { newer: string; earlier: string },
  fresh: (value: T) => T,
): void {
  if (outcome.ok) {
    completeKept<T>(ticket, current, {
      note: current ? notes.newer : notes.earlier,
      change: (value) => ({ ...fresh(value), unsettled: null }),
    });
    return;
  }
  const uncertain = outcome.uncertain === true;
  completeKept<T>(ticket, false, {
    note: outcome.message,
    change: (value) =>
      uncertain ? { ...value, unsettled: value.unsettled ?? sent } : value,
  });
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
      unsettled: null,
    }),
    {
      // Told only while the dialog presents: it closes onto the new list, shown projected ("Not sent yet").
      consumed: (value) => {
        close.current();
        void navigate({
          to: "/tasks/lists/$listId",
          params: { listId: value.listId },
        });
        return null;
      },
    },
  );
  const [problem, setProblem] = useState<ListNameProblem | null>(null);
  const field = useId();
  const discard = () => disownKept(key);
  const save = async () => {
    if (kept.busy) return;
    const { name, listId, localId, unsettled } = kept.value;
    const found = listNameProblem(name);
    setProblem(found);
    if (found !== null) return;
    const ticket = kept.submit();
    if (ticket === null) return;
    // An unsettled save goes again exactly as it was sent (its key, body and captured defaults), whatever is typed now.
    const sent: Unsettled = unsettled ?? {
      name,
      request: createList({ listId, name, defaults: defaults.record, localId }),
      announce: defaults.record === null ? CREATE.reviewNeeded : CREATE.saved,
    };
    let outcome: SaveOutcome = { ok: false, message: null };
    try {
      outcome = await actions.enqueue(sent.request, sent.announce);
    } finally {
      settleSave<CreateInput>(
        ticket,
        sent,
        sent.name === name,
        outcome,
        { newer: RENAME.newer, earlier: CREATE.earlier(sent.name) },
        (value) => ({ ...value, listId: env.newId(), localId: env.newId() }),
      );
    }
  };
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
      </form>
    </Dialog>
  );
}

interface RenameInput {
  name: string;
  localId: string;
  /** A rename of the cached list whose outcome is not known (R1). */
  unsettled: Unsettled | null;
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
      unsettled: null,
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
  // An unsettled rename can always be saved again (it may show already, as the list's queued name).
  const changed =
    list !== null &&
    (kept.value.name !== list.row.label || kept.value.unsettled !== null);
  const save = async () => {
    if (kept.busy) return;
    // Every route into a save is admitted by the LATEST read, not only by the button's state.
    const now = latest.current;
    const { name, localId, unsettled } = kept.value;
    if (now === null) {
      setRefusal(RENAME.gone);
      return;
    }
    const found = listNameProblem(name);
    setProblem(found);
    if (found !== null) return;
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
    const version = now.projected ? undefined : now.row.policy_version;
    // An unsettled rename goes again exactly as it was sent (its key and policy version), whatever is typed now.
    const request =
      unsettled !== null
        ? unsettled.request
        : create !== null
          ? renameQueuedCreate(create, name)
          : version !== undefined
            ? editList({ listId, name, policyVersion: version, localId })
            : null;
    if (request === null) {
      setRefusal(RENAME.waitSync);
      return;
    }
    setRefusal(null);
    const ticket = kept.submit();
    if (ticket === null) return;
    const sent: Unsettled = unsettled ?? {
      name,
      request,
      announce: RENAME.saved,
    };
    let outcome: SaveOutcome = { ok: false, message: null };
    try {
      // An in-place edit of the queued create writes the whole name again and is never `uncertain` here: a retry of it is built anew.
      outcome =
        unsettled === null && create !== null
          ? await actions.editQueued(create.local_id, request, RENAME.saved)
          : await actions.enqueue(request, sent.announce);
    } finally {
      settleSave<RenameInput>(
        ticket,
        sent,
        sent.name === name,
        outcome,
        { newer: RENAME.newer, earlier: RENAME.earlier(sent.name) },
        (value) => ({ ...value, localId: env.newId(), seen: null }),
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
      </form>
    </Dialog>
  );
}
