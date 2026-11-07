import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { openingFocus } from "../../../lib/form-recovery/focus";
import { UNAVAILABLE_WHILE_RELOADING } from "../../../lib/form-recovery/RecoveryBanner";
import { RecoveryNotice } from "../../../lib/form-recovery/RecoveryNotice";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { type KeptRecovery, useKeptInput } from "../kept-input";
import { noteIfRefused, refusalOf } from "../memory";
import type { TaskDefinition, TaskPreset } from "../model/contract";
import { decodePresetChoice, encodePresetChoice } from "../model/recovery";
import { todayIn } from "../model/time";

const PRESETS = "presets";

export const PRESET_COPY = {
  title: "New task",
  description: "Start from a preset, then change anything you like.",
  group: "Presets",
  use: "Use preset",
  scratch: "Start from scratch instead",
  loading: "Loading presets",
  failed: "Couldn't load presets — start from scratch instead.",
  offline: "Presets need a connection",
} as const;

/** The client's own subtext of a preset, from its definition (the server sends only a title). */
export function describeDefinition(definition: TaskDefinition): string {
  const { schedule, goal } = definition;
  const repeat =
    schedule.repeat === null
      ? "Once"
      : schedule.repeat.frequency === "after_completion"
        ? `${schedule.repeat.interval} days after it's done`
        : schedule.repeat.interval === 1
          ? {
              daily: "Every day",
              weekly: "Every week",
              monthly: "Every month",
              yearly: "Every year",
            }[schedule.repeat.frequency]
          : `Every ${schedule.repeat.interval} ${{ daily: "days", weekly: "weeks", monthly: "months", yearly: "years" }[schedule.repeat.frequency]}`;
  const target =
    goal.kind === "checkbox"
      ? "tick when done"
      : goal.kind === "checklist"
        ? `${goal.items.length} items`
        : goal.minimum !== null
          ? `at least ${goal.minimum} ${goal.unit}`
          : `at most ${goal.maximum} ${goal.unit}`;
  return `${repeat} · ${target} · ${copy.PARTICIPATION[definition.participation]}`;
}

/**
 * Q21 `task-presets.html`: six presets from `GET /task-presets` for today in the display zone, as radio cards. "Use preset" fills the form
 * (every field stays editable); "Start from scratch instead" opens an empty form. There is NO built-in list: offline or on failure,
 * "Start from scratch" stays available. A preset is submitted as an ordinary `create_task` (TASK-29).
 *
 * The person's choice of preset is an editing session (`keptAs`, revision 18, R33): the in-dialog sync control keeps it, and the picker
 * opened again shows it (while that preset is still offered). Escape and the close icon leave for the task list, which discards it. The
 * in-dialog sync control goes to the sync screens STRAIGHT from the picker (revision 22, `visit.ts`): passing through the task list first
 * would be a departure that ends the visit owning the choice, and Back from the queue would not find the picker.
 *
 * Revision 38 (design assessment DA-R40-E): the choice's recovery is shown as every recoverable editor's is (`RecoveryNotice`): a restored
 * choice with "Discard instead", the other copies to choose from, a look that could not read the store. While an update reload is being
 * prepared the footer opens no form (a stage chosen then would be input after the last save).
 */
const PICK_RECOVERY: KeptRecovery<string> = {
  context: "task-form:new:preset",
  encode: encodePresetChoice,
  decode: decodePresetChoice,
};

export function PresetPicker({
  zone,
  keptAs,
  onUse,
  onScratch,
  onClose,
}: {
  zone: string;
  keptAs: string;
  onUse(preset: TaskPreset): void;
  onScratch(): void;
  onClose(): void;
}) {
  const env = useTasksEnv();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; presets: TaskPreset[] }
    | { kind: "failed"; requestId?: string }
    | { kind: "offline" }
  >(env.online ? { kind: "loading" } : { kind: "offline" });
  // Revision 37 (WEB-14a R40): the choice is recoverable around an app-update reload (Q4), as the picker's own versioned text.
  const choice = useKeptInput<string>(keptAs, env.identity, () => "", {
    consumed: () => null,
    recover: PICK_RECOVERY,
  });
  // Set by the in-dialog sync control just before it closes the dialog and opens the sync screens: that close is not leaving for the list.
  const toSync = useRef(false);
  useEffect(() => {
    if (!env.online) {
      setState({ kind: "offline" });
      return;
    }
    // A refused read is not asked again on a remount (a 403 remounts the tree), only when the picker is opened afresh by the person.
    if (refusalOf(env.identity, PRESETS) !== null) {
      setState({ kind: "failed" });
      return;
    }
    let live = true;
    setState({ kind: "loading" });
    void env.api
      .readPresets({ startDate: todayIn(zone, env.now()), zone })
      .then((result) => {
        noteIfRefused(env.identity, PRESETS, result);
        if (!live) return;
        if (result.ok) setState({ kind: "ready", presets: result.value });
        else if (result.kind === "offline") setState({ kind: "offline" });
        else if (result.kind !== "closed")
          setState({
            kind: "failed",
            ...("requestId" in result && result.requestId
              ? { requestId: result.requestId }
              : {}),
          });
      });
    return () => {
      live = false;
    };
  }, [env.api, env.online, zone, env]);
  const locked = choice.recovery?.locked === true;
  // WEB-14a revision 51 (F-R51-1, D1): a restored choice, and "Discard instead", focus the chosen preset (the checked radio, read from the
  // committed DOM: a discard checks the first). While the presets are read nothing is focused yet (the request waits for them); offline,
  // failed or with no presets there is no choice, so the dialog's own opening focus is used (decision D1, Kieran, 3 November 2026).
  const body = useRef<HTMLDivElement>(null);
  const kind = useRef(state.kind);
  kind.current = state.kind;
  const choiceFocus = () => {
    const root = body.current;
    if (!root || kind.current === "loading") return null;
    return (
      root.querySelector<HTMLElement>('input[type="radio"]:checked') ??
      root.querySelector<HTMLElement>('input[type="radio"]') ??
      openingFocus(root)
    );
  };
  // The person's choice while it is offered, else the first preset.
  const chosen =
    state.kind !== "ready"
      ? ""
      : state.presets.some((p) => p.id === choice.value)
        ? choice.value
        : (state.presets[0]?.id ?? "");
  const preset =
    state.kind === "ready"
      ? state.presets.find((p) => p.id === chosen)
      : undefined;
  return (
    <Dialog
      open
      onClose={() => {
        if (toSync.current) toSync.current = false;
        else onClose();
      }}
      onRetainDraft={() => {
        toSync.current = true;
      }}
      title={PRESET_COPY.title}
      description={PRESET_COPY.description}
      footer={
        locked ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              disabled
              reason={UNAVAILABLE_WHILE_RELOADING}
            >
              {PRESET_COPY.scratch}
            </Button>
            {preset !== undefined ? (
              <Button
                variant="default"
                disabled
                reason={UNAVAILABLE_WHILE_RELOADING}
              >
                {PRESET_COPY.use}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onScratch}>
              {PRESET_COPY.scratch}
            </Button>
            {preset !== undefined ? (
              <Button variant="default" onClick={() => onUse(preset)}>
                {PRESET_COPY.use}
              </Button>
            ) : null}
          </div>
        )
      }
    >
      <div ref={body} data-preset-picker={state.kind}>
        {choice.recovery ? (
          <RecoveryNotice
            recovery={choice.recovery}
            firstFieldRef={choiceFocus}
          />
        ) : null}
        {state.kind === "loading" ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">{PRESET_COPY.loading}</span>
            {[0, 1, 2].map((n) => (
              <div
                key={n}
                className="min-h-12 animate-pulse rounded-lg bg-muted"
              />
            ))}
          </div>
        ) : state.kind === "offline" ? (
          <p className="text-sm text-muted-foreground">{PRESET_COPY.offline}</p>
        ) : state.kind === "failed" ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted-foreground">
              {PRESET_COPY.failed}
            </p>
            {state.requestId ? (
              <p className="select-all font-num text-xs text-muted-foreground">
                {copy.REQUEST_ID(state.requestId)}
              </p>
            ) : null}
          </div>
        ) : (
          <fieldset className="flex flex-col gap-2" data-preset-list="">
            <legend className="sr-only">{PRESET_COPY.group}</legend>
            {state.presets.map((p) => (
              <label
                key={p.id}
                data-contract-id={p.id}
                className="atlas-transition flex min-h-12 items-start gap-2.5 rounded-lg border border-border bg-background p-3 text-left hover:border-input hover:bg-accent"
              >
                <input
                  type="radio"
                  name="task-preset"
                  value={p.id}
                  checked={chosen === p.id}
                  onChange={() => choice.edit(() => p.id)}
                  className="mt-0.5 size-4"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">
                    {p.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {describeDefinition(p.definition)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}
