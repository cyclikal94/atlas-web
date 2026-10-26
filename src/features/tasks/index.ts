/**
 * WEB-10a's PUBLIC INTERFACE for WEB-10b, WEB-10c and WEB-14b (docs/tasks.md), with WEB-10b's lists (docs/lists.md). Import the task
 * model, parsers, command builders and the shared components from here, never from a deeper path.
 */

export { todayPath } from "../today/route";
export { type TaskActions, useTaskActions } from "./actions";
export { RecordCard } from "./detail/RecordCard";
export {
  TasksBoundary,
  type TasksEnv,
  TasksEnvProvider,
  useTasksEnv,
} from "./env";
export { listPath } from "./lists/path";
export * from "./model/commands";
export * from "./model/contract";
export {
  actionable,
  aggregate,
  eligible,
  evaluate,
  finalise,
  inDayView,
  layer,
  type PendingEvidence,
  type PersonalResult,
  personalResult,
  scheduledOn,
} from "./model/evaluate";
export { occurrenceId, progressId, slotKey, uuidV5 } from "./model/ids";
export * from "./model/list-view";
export * from "./model/lists";
export * from "./model/time";
export { registerTaskCommands } from "./register";
export { taskPath } from "./route";
export { TodayRow } from "./today/TodayRow";
export { composeRow, type RowModel } from "./view";
