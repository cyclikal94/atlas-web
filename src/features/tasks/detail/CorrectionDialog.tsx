import { useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
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
import { resolveWallTime } from "../model/time";
import type { RowModel } from "../view";

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
  saved: "Correction saved on this device. Not sent yet.",
  conflictTitle: "Someone else corrected this day first",
  current: "Now saved",
  mine: "Yours",
  saveMine: "Save mine on the current version",
  discardMine: "Discard mine",
  undated: "No date",
} as const;

/**
 * The draft of an open correction, kept for its occurrence and the displayed identity while the in-dialog sync control takes the person to
 * the queue (the `retained.ts` pattern of WEB-12a): page memory only, never stored. Cancel, Escape and the close icon discard it.
 */
const retained = new Map<string, CorrectionState>();
export const retainedKey = (identity: string, occurrenceId: string) =>
  `${identity}\u0000${occurrenceId}`;
export function forgetAllCorrections(): void {
  retained.clear();
}
/** What the person last saved, by draft: so a version conflict can be resolved by their explicit act, on the current version. */
const saved = new Map<
  string,
  { occurrenceId: string; state: CorrectionState }
>();
export const savedCorrection = (localId: string) => saved.get(localId) ?? null;

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
  const key = retainedKey(identity, row.id);
  const [state, setState] = useState<CorrectionState>(
    () => retained.get(key) ?? correctionFrom(row.data),
  );
  const [errors, setErrors] = useState<
    Partial<Record<CorrectionField, string>>
  >({});
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const weekday =
    row.data.slot.date === null
      ? CORRECTION_COPY.undated
      : weekdayLabel(row.data.slot.date);
  const goal = row.data.definition.goal;
  const set = (patch: Partial<CorrectionState>) =>
    setState((s) => ({ ...s, ...patch }));
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
    retained.delete(key);
    setState(correctionFrom(row.data));
    setErrors({});
  };
  const save = async () => {
    const result = correctionResult(row.data, state);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setBusy(true);
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
      if (outcome.ok) {
        saved.set(outcome.localId, { occurrenceId: row.id, state });
        retained.delete(key);
        onClose();
      }
    } finally {
      setBusy(false);
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
      onRetainDraft={() => retained.set(key, state)}
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
            ) : busy ? (
              <Button disabled reason={copy.SAVING}>
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
      <div className="flex flex-col gap-4" data-correction-form="">
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
              onChange={(e) => set({ time: e.target.value })}
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
