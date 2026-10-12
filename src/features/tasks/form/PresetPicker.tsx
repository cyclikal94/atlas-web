import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { noteIfRefused, refusalOf } from "../memory";
import type { TaskDefinition, TaskPreset } from "../model/contract";
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
 */
export function PresetPicker({
  zone,
  onUse,
  onScratch,
  onClose,
}: {
  zone: string;
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
  const [chosen, setChosen] = useState<string>("");
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
        if (result.ok) {
          setState({ kind: "ready", presets: result.value });
          setChosen(result.value[0]?.id ?? "");
        } else if (result.kind === "offline") setState({ kind: "offline" });
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
  const preset =
    state.kind === "ready"
      ? state.presets.find((p) => p.id === chosen)
      : undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      title={PRESET_COPY.title}
      description={PRESET_COPY.description}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="quiet" onClick={onScratch}>
            {PRESET_COPY.scratch}
          </Button>
          {preset !== undefined ? (
            <Button variant="primary" onClick={() => onUse(preset)}>
              {PRESET_COPY.use}
            </Button>
          ) : null}
        </div>
      }
    >
      <div data-preset-picker={state.kind}>
        {state.kind === "loading" ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">{PRESET_COPY.loading}</span>
            {[0, 1, 2].map((n) => (
              <div key={n} className="min-h-12 rounded-row bg-raised" />
            ))}
          </div>
        ) : state.kind === "offline" ? (
          <p className="text-[13px] text-ink-2">{PRESET_COPY.offline}</p>
        ) : state.kind === "failed" ? (
          <div className="flex flex-col gap-1">
            <p className="text-[13px] text-ink-2">{PRESET_COPY.failed}</p>
            {state.requestId ? (
              <p className="select-all font-num text-[12px] text-ink-2">
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
                className="atlas-transition flex min-h-12 items-start gap-2.5 rounded-row border border-hairline-strong bg-canvas p-3 text-left hover:border-field-edge"
              >
                <input
                  type="radio"
                  name="task-preset"
                  value={p.id}
                  checked={chosen === p.id}
                  onChange={() => setChosen(p.id)}
                  className="mt-0.5 size-[15px]"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-[13.5px] font-medium text-ink-1">
                    {p.title}
                  </span>
                  <span className="text-[12px] text-ink-2">
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
