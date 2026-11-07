import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { useFormRecoveryPort } from "../../../data";
import type {
  RecoverableModel,
  RecoveryControls,
} from "../../../lib/form-recovery/model";
import type { DiscardResult } from "../../../lib/form-recovery/port";
import { RecoveryNotice } from "../../../lib/form-recovery/RecoveryNotice";
import { pageFormRegistry } from "../../../lib/form-recovery/registry";
import type { TaskActions } from "../actions";
import * as copy from "../copy";
import { weekdayLabel } from "../format";
import { reviseOccurrence } from "../model/commands";
import {
  type CorrectionField,
  type CorrectionState,
  correctionFrom,
  correctionResult,
} from "../model/correction";
import {
  correctionFormContext,
  correctionRecoveryValues,
  restoreCorrection,
} from "../model/recovery";
import { resolveWallTime } from "../model/time";
import type { RowModel } from "../view";
import {
  type TaskAttachment,
  useTaskAttachment,
  useTaskRouteMoved,
  useTaskScreenAt,
  useTaskVisit,
} from "../visit";
import {
  adoptCorrection,
  completeCorrection,
  correctionEntry,
  correctionKey,
  discardCorrection,
  editCorrection,
  forgetCorrectionSessions,
  linkCorrection,
  openCorrection,
  releaseCorrection,
  resetCorrection,
  resumable,
  retainCorrection,
  submitCorrection,
  subscribeCorrection,
} from "./correction-owner";

export const CORRECTION_COPY = {
  open: "Correct this day",
  title: (weekday: string) => `Correct ${weekday}'s entry`,
  lead: (weekday: string) =>
    `This changes ${weekday} only. The task itself, and every other day, stays as it is.`,
  target: "Target for this day",
  was: (old: string) => `Was ${old}`,
  minimum: "At least",
  maximum: "At most",
  unit: "Unit",
  item: (n: number) => `Item ${n}`,
  date: "The date it counts for",
  time: "Time of day",
  timeHint: "Leave empty for any time that day.",
  open_: "You can start it (days before)",
  close: "How long it stays open (days)",
  roster: "Who's on it stays the same.",
  footer: "Nothing is deleted — corrections are added on top.",
  cancel: "Cancel",
  save: "Save correction",
  denied: "You can't correct this day",
  deniedKept:
    "You can't correct this day any more. What you entered is kept here.",
  saved: "Correction saved on this device. Not sent yet.",
  conflictTitle: "Someone else corrected this day first",
  current: "Now saved",
  mine: "Yours",
  saveMine: "Save mine on the current version",
  replacing: "Saving your correction…",
  replaceFailed: "Your correction wasn't saved on the current version.",
  replaceDenied:
    "You can't correct this day any more. Your saved correction stays until you discard it.",
  replaceChanged:
    "Your correction changed somewhere else. Check it, then try again.",
  discardMine: "Discard mine",
  mineUnavailable: "Your saved correction can't be read on this device.",
  waitingNewer: "The other correction hasn't reached this device yet.",
  undated: "No date",
} as const;

/**
 * The draft of an open correction is owned by `correction-owner.ts` (R3, revision 2): kept for its occurrence and the displayed identity while
 * the in-dialog sync control takes the person to the queue (the `retained.ts` pattern of WEB-12a), page memory only, never stored. Cancel,
 * Escape and the close icon discard it. A save consumes only the exact session and revision it submitted.
 */
export const retainedKey = correctionKey;

/**
 * Revision 37 (WEB-14a R40): the correction's session as one recoverable text (version 1), read back against the occurrence as this device
 * has it now (`restoreCorrection`: a label of an item it no longer has, or a value of another shape, makes it unreadable: offered, never
 * restored in part).
 */
const encodeCorrection = (state: CorrectionState): string =>
  JSON.stringify({
    v: 1,
    state: JSON.parse(correctionRecoveryValues(state).correction ?? "null"),
  });
function decodeCorrection(row: RowModel, text: string): CorrectionState | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== "object" || raw.v !== 1) return null;
    return restoreCorrection(
      { correction: JSON.stringify(raw.state) },
      row.data,
    );
  } catch {
    return null;
  }
}

/** The correction model of `row`'s day, linked for this identity, shown while mounted and bound to the account's store. */
function useCorrectionModel(
  row: RowModel,
  identity: string,
  /** An editor shows it (the dialog); a host that only looks for a copy does not. */
  shown: boolean,
): RecoverableModel {
  const port = useFormRecoveryPort();
  const visitOf = useTaskVisit();
  const latest = useRef({ row, visitOf });
  latest.current = { row, visitOf };
  const key = correctionKey(identity, row.id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one model per key and identity; the row is read through `latest` (a copy is read against the occurrence as it is now)
  const model = useMemo(
    () =>
      linkCorrection(
        key,
        identity,
        correctionFormContext(row.id),
        {
          encode: encodeCorrection,
          decode: (text) => decodeCorrection(latest.current.row, text),
        },
        () => correctionFrom(latest.current.row.data),
        () => latest.current.visitOf(identity),
      ),
    [key, identity],
  );
  useEffect(() => (shown ? model.show() : undefined), [model, shown]);
  // The dialog binds it itself, after its session opened (the look must find that session's start, not take it for input).
  useEffect(() => {
    if (!shown) model.bind(port);
  }, [model, port, shown]);
  return model;
}

/**
 * Revision 37 (WEB-14a R40; design assessment C1): the DETAIL looks for a correction the page before an update left for the day it shows:
 * the dialog is not open after a reload, so a look inside it would never run. A copy restored is a retained session of this visit, and the
 * dialog is opened on it (`onRestored`), at the stage the person had reached; nothing is submitted. Renders nothing.
 */
export function CorrectionRecoveryHost({
  row,
  identity,
  onRestored,
}: {
  row: RowModel;
  identity: string;
  onRestored(occurrenceId: string): void;
}) {
  const model = useCorrectionModel(row, identity, false);
  const view = useSyncExternalStore(model.subscribe, model.view, model.view);
  const restored = view.restored !== null;
  const latest = useRef(onRestored);
  latest.current = onRestored;
  useEffect(() => {
    if (restored && resumable(correctionKey(identity, row.id)) !== null)
      latest.current(row.id);
  }, [restored, row.id, identity]);
  return null;
}
export function forgetAllCorrections(): void {
  forgetCorrectionSessions();
}

export function CorrectionDialog({
  row,
  identity,
  open,
  onClose,
  actions,
  progressIds,
  writable,
}: {
  row: RowModel;
  identity: string;
  open: boolean;
  onClose(): void;
  actions: Pick<TaskActions, "enqueue">;
  /** Every progress stream under the occurrence this device knows (the server raises each). */
  progressIds: readonly string[];
  writable: boolean;
}) {
  const key = correctionKey(identity, row.id);
  const [state, setState] = useState<CorrectionState>(
    () => resumable(key) ?? correctionFrom(row.data),
  );
  // Revision 37 (WEB-14a R40): the session's recoverable model (the registry's, while the dialog shows it), its view and the update's hold.
  const model = useCorrectionModel(row, identity, true);
  const body = useRef<HTMLDivElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // A date or time field partly typed has no value the session can hold: unfinished, never saved as empty.
    model.probe(() =>
      Array.from(body.current?.querySelectorAll("input") ?? []).some(
        (input) => input.validity?.badInput === true,
      ),
    );
    return () => model.probe(null);
  }, [model]);
  const recoveryView = useSyncExternalStore(
    model.subscribe,
    model.view,
    model.view,
  );
  const locked = useSyncExternalStore(
    pageFormRegistry.subscribe,
    pageFormRegistry.frozen,
    pageFormRegistry.frozen,
  );
  const [errors, setErrors] = useState<
    Partial<Record<CorrectionField, string>>
  >({});
  const [busy, setBusy] = useState(false);
  // The editing session this dialog holds (R3, revision 2): every edit moves its revision in the owner, which outlives this mount. A save
  // that succeeds consumes the draft, and the session's current editor closes, only if nothing was edited after the state it submitted
  // (PRODUCT-DECISIONS-20261011): newer input stays in the open dialog, or retained while the person is in the queue, and is never consumed
  // by the older save's acknowledgement, whichever mount made it.
  const session = useRef<number | null>(null);
  const latest = useRef({ onClose, row });
  latest.current = { onClose, row };
  // The session is the visit's (revision 22, `visit.ts`): asked for when the dialog opens, not when it renders.
  const visitOf = useTaskVisit();
  // Closing on a consumed save acts on the screen: only a dialog the person is still at does (revision 23, R35; `visit.ts`).
  const attachTo = useTaskAttachment();
  const shownAt = useTaskScreenAt();
  const onRouteMoved = useTaskRouteMoved();
  const attachment = useRef<TaskAttachment | null>(null);
  // The attachment that may close the dialog on the pending save's success: the one it had when it took (or resumed) that save. A newer
  // attachment (the person came back) is for later work only, never leave for an older save to act (revision 24, R36).
  const acting = useRef<TaskAttachment | null>(null);
  // Its save consumed while the person was elsewhere, the dialog still mounted: it holds no session until it starts afresh at its address.
  const [dormant, setDormant] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor opened for this key and identity leaves the screen
  useLayoutEffect(
    () => () => {
      attachment.current?.detach();
      attachment.current = null;
    },
    [key, identity],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key and identity are the reason; the visit is asked for as the dialog opens
  useEffect(() => {
    let owner = visitOf(identity);
    let here = attachTo(owner);
    attachment.current = here;
    let spent = false;
    const open = () => {
      const opened = openCorrection(
        key,
        identity,
        () => correctionFrom(latest.current.row.data),
        owner,
      );
      session.current = opened.session;
      acting.current = here;
      setState(opened.state);
      setErrors({});
      setBusy(opened.submitting !== null);
      setDormant(false);
    };
    open();
    // The person is at the dialog's address again and React never removed it (revision 24, R36): it is the editor they are at, so it is
    // attached anew (on the visit going on there, which now owns the session it holds), and a dialog whose save was consumed meanwhile
    // starts afresh from what the day shows now, as a new dialog there would: never the consumed input, never a Save that does nothing.
    const renew = () => {
      if (owner === null || attachment.current !== here) return;
      if (here === null || !here.presents()) {
        if (!shownAt(owner.address)) return;
        const next = visitOf(identity);
        const again = attachTo(next);
        if (next === null || again === null || !again.presents()) {
          again?.detach();
          return;
        }
        here?.detach();
        here = again;
        attachment.current = again;
        if (next !== owner && session.current !== null)
          adoptCorrection(key, session.current, next);
        owner = next;
      }
      if (spent) {
        spent = false;
        open();
      }
    };
    const unheard = onRouteMoved(renew);
    const stop = subscribeCorrection(key, (event) => {
      if (event.session !== session.current) return;
      if (event.kind === "restored") {
        const entry = correctionEntry(key);
        if (entry !== null) setState(entry.state);
        return;
      }
      setBusy(false);
      if (event.kind !== "consumed") return;
      session.current = null;
      // Asked now, immediately before acting: a dialog the person left since it took this save does not close (R35).
      const by = acting.current;
      if (by === null || by.presents()) {
        latest.current.onClose();
        return;
      }
      spent = true;
      setDormant(true);
      renew();
    });
    return () => {
      here?.detach();
      unheard();
      stop();
      if (session.current !== null) releaseCorrection(key, session.current);
      session.current = null;
    };
  }, [key, identity]);
  // Revision 37 (R40): bound after the session opened (above).
  const port = useFormRecoveryPort();
  useEffect(() => {
    model.bind(port);
  }, [model, port]);
  const formId = useId();
  const weekday =
    row.data.slot.date === null
      ? CORRECTION_COPY.undated
      : weekdayLabel(row.data.slot.date);
  const goal = row.data.definition.goal;
  const set = (patch: Partial<CorrectionState>) => {
    const next = { ...state, ...patch };
    // Refused while an update reload is prepared (R40): the dialog keeps what was saved.
    if (session.current !== null && !editCorrection(key, session.current, next))
      return;
    setState(next);
  };
  const field = (name: CorrectionField) =>
    errors[name]
      ? { "aria-invalid": true, "aria-describedby": `${formId}-${name}` }
      : {};
  const message = (name: CorrectionField) =>
    errors[name] ? (
      <p id={`${formId}-${name}`} className="text-[12px] text-conflict-text">
        {errors[name]}
      </p>
    ) : null;
  const discard = () => {
    if (session.current !== null && !discardCorrection(key, session.current))
      return;
    setState(correctionFrom(row.data));
    setErrors({});
  };
  // "Discard instead" of a restored correction (R40): its copies go, and the dialog shows the day as it is now (the session goes on).
  const recovery: RecoveryControls = {
    view: recoveryView,
    locked,
    discard() {
      // Admitted at the gesture or not at all (revision 38, R40-A): the session, the dialog and the model take the day as it is now in
      // this same step; the copies' removal completing later changes nothing on screen.
      if (!model.accepting()) return Promise.resolve<DiscardResult>("failed");
      const fresh = correctionFrom(row.data);
      const result = model.discard(encodeCorrection(fresh));
      if (session.current !== null)
        resetCorrection(key, session.current, fresh);
      setState(fresh);
      setErrors({});
      return result;
    },
    retry: () => model.retry(),
    checkAgain: model.checkAgain,
    restoreAlternative: (copy) => model.restoreAlternative(copy.tabInstanceId),
    discardAlternative: (copy) => model.discardAlternative(copy.tabInstanceId),
  };
  // Whether a correction may be saved now, by this render's facts (R30): every route into a save is admitted here, not only by the
  // footer's state. A known denial of the occurrence (`can_edit: false` as this device last read it) keeps what was typed, unsaved; the
  // writing transaction checks the denial again (`requiresEdit`), so one committed after this render is honoured too.
  const admitted = writable && row.canEdit && !busy && !dormant;
  const save = async () => {
    if (!admitted) return;
    const result = correctionResult(row.data, state);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    const ticket =
      session.current === null ? null : submitCorrection(key, session.current);
    if (ticket === null) return;
    acting.current = attachment.current;
    setBusy(true);
    let ok = false;
    try {
      const outcome = await actions.enqueue(
        reviseOccurrence(
          {
            occurrenceId: row.id,
            current: row.data,
            definition: result.definition,
            date: result.date,
            time: result.time,
            progressIds,
          },
          resolveWallTime,
        ),
        CORRECTION_COPY.saved,
      );
      ok = outcome.ok;
    } catch {
      // The actions report a store that threw as a refusal; anything else that throws saved nothing either: the input stays.
      ok = false;
    } finally {
      // The owner decides: it consumes only this exact session and revision, and tells the session's CURRENT editor (this one only if it
      // is still mounted and still holds the session) to close or to clear its pending mark.
      completeCorrection(ticket, ok);
    }
  };
  const was = (text: string | null) =>
    text === null || text === "" ? null : (
      <span className="text-[12px] text-ink-2">
        {CORRECTION_COPY.was(text)}
      </span>
    );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={CORRECTION_COPY.title(weekday)}
      description={CORRECTION_COPY.lead(weekday)}
      onDiscard={discard}
      onRetainDraft={() => {
        if (session.current !== null) retainCorrection(key, session.current);
      }}
      footer={
        <div className="flex flex-col gap-2">
          <p className="text-[12px] text-ink-2">{CORRECTION_COPY.footer}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="quiet"
              onClick={() => {
                discard();
                onClose();
              }}
            >
              {CORRECTION_COPY.cancel}
            </Button>
            {!writable ? (
              <Button disabled reason={copy.NOT_WRITABLE}>
                {CORRECTION_COPY.save}
              </Button>
            ) : !row.canEdit ? (
              <Button disabled reason={CORRECTION_COPY.deniedKept}>
                {CORRECTION_COPY.save}
              </Button>
            ) : busy ? (
              <Button disabled reason={copy.SAVING}>
                {CORRECTION_COPY.save}
              </Button>
            ) : dormant ? (
              <Button disabled reason={CORRECTION_COPY.saved}>
                {CORRECTION_COPY.save}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void save()}>
                {CORRECTION_COPY.save}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div ref={body} className="flex flex-col gap-4" data-correction-form="">
        <RecoveryNotice recovery={recovery} firstFieldRef={firstField} />
        {goal.kind !== "checkbox" ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-[13px] font-medium text-ink-1">
              {CORRECTION_COPY.target}
            </legend>
            {goal.kind === "numeric" ? (
              <div className="grid gap-2 tablet:grid-cols-2">
                <div>
                  <Input
                    label={CORRECTION_COPY.minimum}
                    inputMode="decimal"
                    value={state.minimum}
                    {...field("minimum")}
                    onChange={(e) => set({ minimum: e.target.value })}
                  />
                  {was(goal.minimum)}
                  {message("minimum")}
                </div>
                <div>
                  <Input
                    label={CORRECTION_COPY.maximum}
                    inputMode="decimal"
                    value={state.maximum}
                    {...field("maximum")}
                    onChange={(e) => set({ maximum: e.target.value })}
                  />
                  {was(goal.maximum)}
                  {message("maximum")}
                </div>
                <div>
                  <Input
                    label={CORRECTION_COPY.unit}
                    value={state.unit}
                    {...field("unit")}
                    onChange={(e) => set({ unit: e.target.value })}
                  />
                  {was(goal.unit)}
                  {message("unit")}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {goal.items.map((item, index) => (
                  <Input
                    key={item.id}
                    label={CORRECTION_COPY.item(index + 1)}
                    value={state.labels[item.id] ?? item.label}
                    onChange={(e) =>
                      set({
                        labels: { ...state.labels, [item.id]: e.target.value },
                      })
                    }
                  />
                ))}
                {message("labels")}
              </div>
            )}
          </fieldset>
        ) : null}
        <div className="grid gap-3 tablet:grid-cols-2">
          <div>
            <Input
              ref={firstField}
              label={CORRECTION_COPY.date}
              type="date"
              value={state.date}
              {...field("date")}
              onChange={(e) => set({ date: e.target.value })}
            />
            {was(row.data.slot.date)}
            {message("date")}
          </div>
          <div>
            <Input
              label={CORRECTION_COPY.time}
              type="time"
              value={state.time}
              {...field("time")}
              // The person's own edit of the time: from now on the minute shown is what is sent (R31).
              onChange={(e) =>
                set({
                  time: e.target.value,
                  keptTime: null,
                  timeUnconfirmed: false,
                })
              }
            />
            <span className="text-[12px] text-ink-2">
              {CORRECTION_COPY.timeHint}
            </span>
            {message("time")}
          </div>
          <div>
            <Input
              label={CORRECTION_COPY.open_}
              inputMode="numeric"
              value={state.openDaysBefore}
              {...field("openDaysBefore")}
              onChange={(e) => set({ openDaysBefore: e.target.value })}
            />
            {message("openDaysBefore")}
          </div>
          <div>
            <Input
              label={CORRECTION_COPY.close}
              inputMode="numeric"
              value={state.closeDaysAfter}
              {...field("closeDaysAfter")}
              onChange={(e) => set({ closeDaysAfter: e.target.value })}
            />
            {message("closeDaysAfter")}
          </div>
        </div>
        <p className="text-[12.5px] text-ink-2">{CORRECTION_COPY.roster}</p>
      </div>
    </Dialog>
  );
}
