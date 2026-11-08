import { useCallback } from "react";
import { useSharingDefaults } from "../../../data";
import { type SaveOutcome, useTaskActions } from "../actions";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { createTask } from "../model/commands";
import { applicable, emptyForm } from "../model/form";
import { occurrenceId, progressId } from "../model/ids";
import { firstSlot } from "../model/time";

/**
 * Quick add (the Final design): a task from a line of text on the day itself, saved through the same `create_task` the form sends. The
 * task is a one-off tick for the chosen day, at any time, just for me, shared by my defaults; anything else is the form's. The ids are the
 * contract's deterministic ones, computed before enqueue, so the new row appears on the day at once (the outstanding create is projected
 * into the day as every create is) and is sent when Atlas can.
 */
export function useQuickAdd(day: string, zone: string) {
  const env = useTasksEnv();
  const actions = useTaskActions();
  const defaults = useSharingDefaults();
  const record = defaults.record;
  return useCallback(
    async (text: string): Promise<SaveOutcome> => {
      const state = {
        ...emptyForm(zone, day),
        title: text,
        repeat: "none" as const,
        startDate: day,
      };
      const result = applicable(state);
      if (!result.ok)
        return { ok: false, message: result.errors.title ?? null };
      const taskId = env.newId();
      const executionId = env.newId();
      const slot = firstSlot(result.definition, env.now());
      const occurrence =
        slot === null ? null : await occurrenceId(taskId, slot.key);
      const progress =
        occurrence === null
          ? null
          : await progressId(occurrence, env.accountId);
      return actions.enqueue(
        createTask({
          taskId,
          executionId,
          occurrenceId: occurrence,
          progressId: progress,
          title: result.title,
          definition: result.definition,
          sharing: "defaults",
          defaults: record,
        }),
        record === null ? copy.QUICK_ADD.review : copy.QUICK_ADD.added(text),
      );
    },
    [actions, env, record, day, zone],
  );
}
