/**
 * The ONLY import path other slices may use for the data layer (the boundary test, like the session's). Exports grow milestone by
 * milestone; nothing outside `src/data` may import a deeper path.
 *
 * What the BOOT path imports from here must stay small and must not reach Dexie: `createDataDeletionPorts` is a static shim that
 * loads the heavy implementation lazily (plan 5.3.1), and `check:artefacts` asserts that `dexie` is not in the initial chunk. The
 * UI exports below carry no Dexie either (the browser composition is a dynamic import inside the provider), and the build marks
 * `src/data` modules side-effect free, so a boot that uses only the ports does not pull the rest of this file's graph along.
 */

export type { ReadResult } from "./engine/identity-task";
export type { Observation } from "./model/observation";
export type {
  Bases,
  BuildResult,
  EnqueueRequest,
  TargetSpec,
} from "./model/outbox";
export { OutboxRequestError } from "./model/outbox";
// ---- status, queue and profile for the UI (plan 5.7, 5.8) -----------------------------------------------------------------------
export type { MergedResource } from "./model/overlay";
export type { QueueSummary } from "./model/queue-summary";
export { accountDatabaseName } from "./model/schema";
export type {
  CacheState,
  GateState,
  Notice,
  StatusInputs,
} from "./model/status";
export type {
  AccountId,
  CacheRow,
  DraftRow,
  DraftStatus,
  DraftWithCommand,
  Epoch,
  JsonObject,
  LocalId,
  ProjectionPatch,
  ResourceId,
  ResourceKind,
} from "./model/types";
export type {
  DiscardOutcome,
  EditOutcome,
  EnqueueOutcome,
  Outbox,
  SupersedeOutcome,
} from "./outbox/outbox";
export {
  type CommandRegistry,
  type CommandSpec,
  type ConflictContext,
  type ConflictDecision,
  type ConflictHandlerRegistry,
  commandKind,
  createCommandRegistry,
  createConflictHandlerRegistry,
} from "./outbox/registries";
export type {
  ConflictPage,
  ListedResource,
  QueuePage,
  ResourcePage,
} from "./plans/outbox";
export type {
  Outstanding,
  PendingCreatesPage,
  ResourceView,
} from "./plans/pending-reads";
export {
  createDataDeletionPorts,
  type DeletionPortsOptions,
} from "./ports/deletion-ports";
export type { Loadable } from "./store/port";
export {
  createDataEnv,
  type DataActions,
  type DataEnv,
  type DataEnvDeps,
} from "./ui/env";
export {
  type ConflictRow,
  DataEnvProvider,
  DataProvider,
  useAccountLabel,
  useCachedResource,
  useCacheGate,
  useCommandDescription,
  useConflictInbox,
  useDataActions,
  useDataEnv,
  useDraftQueue,
  useNotices,
  useOptionalDataEnv,
  useOutstanding,
  usePendingCreates,
  useQueueSummary,
  useResourceList,
  useResourceView,
  useStatusInputs,
  useSyncStatusModel,
} from "./ui/react";
