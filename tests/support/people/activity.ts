import {
  ACTIVITY_SUMMARIES,
  type ActivityAccount,
  type ActivityTarget,
  type ActivityType,
  type PersonActivityEvent,
} from "../../../src/features/people/model/activity";
import { ACTIVITY_COVERAGE } from "./world";

/**
 * WEB-19 test builders: activity events as the contract sends them (`summary` from the type, the members each type carries). A builder
 * never makes an event the strict parser would refuse unless the test overrides a member on purpose.
 */
export const eventId = (n: number): string =>
  `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, "0")}`;

export const YOU: ActivityAccount = { kind: "you" };
export const SOMEONE: ActivityAccount = { kind: "someone_else" };
export const accountActor = (
  account_id: string,
  username: string,
): ActivityAccount => ({ kind: "account", account_id, username });

export const personTarget = (
  id: string,
  label: string,
  over: Partial<ActivityTarget> = {},
): ActivityTarget => ({
  kind: "person",
  id,
  label,
  archived: false,
  state: "current",
  ...over,
});

export const fieldTarget = (
  id: string,
  label: string,
  over: Partial<ActivityTarget> = {},
): ActivityTarget => ({
  kind: "field",
  id,
  label,
  archived: false,
  state: "current",
  field_kind: "text",
  ...over,
});

/** One event of `type` about `target` (the n-th: its id and, by default, its time count down from the coverage start + 1 day). */
export function activityEvent(
  n: number,
  type: ActivityType,
  target: ActivityTarget,
  over: Partial<PersonActivityEvent> = {},
): PersonActivityEvent {
  const event: PersonActivityEvent = {
    id: eventId(n),
    occurred_at: ACTIVITY_COVERAGE + 86_400 - n * 60,
    type,
    summary: ACTIVITY_SUMMARIES[type],
    actor: YOU,
    target,
  };
  if (type === "field_edited") event.changed = ["value"];
  if (type === "person_linked" || type === "person_unlinked")
    event.account = YOU;
  return { ...event, ...over };
}

/** `count` field edits of `target`, newest first, numbered from `from`. */
export function manyEdits(
  count: number,
  target: ActivityTarget,
  from = 1,
): PersonActivityEvent[] {
  return Array.from({ length: count }, (_, i) =>
    activityEvent(from + i, "field_edited", target),
  );
}
