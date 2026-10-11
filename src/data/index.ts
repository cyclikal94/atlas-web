/**
 * The ONLY import path other slices may use for the data layer (the boundary test, like the session's). Exports grow milestone by
 * milestone; nothing outside `src/data` may import a deeper path.
 *
 * What the BOOT path imports from here must stay small and must not reach Dexie: `createDataDeletionPorts` is a static shim that
 * loads the heavy implementation lazily (plan 5.3.1), and `check:artefacts` asserts that `dexie` is not in the initial chunk. The
 * UI exports below carry no Dexie either (the browser composition is a dynamic import inside the provider), and the build marks
 * `src/data` modules side-effect free, so a boot that uses only the ports does not pull the rest of this file's graph along.
 */

export type {
  Acquisition,
  DefaultsSource,
  RefreshOutcome,
  RequestBoundary,
} from "./engine/defaults-source";
export type { ReadResult } from "./engine/identity-task";
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
export {
  type ReviewConfirmation,
  type ReviewedDraft,
  reviewedOf,
} from "./model/review-confirmation";
export { accountDatabaseName } from "./model/schema";
// ---- the sharing defaults (WEB-12a, B5): the record, its capture for queued creates and the review's cases --------------------------
export {
  type CapturedAccount,
  type CapturedHousehold,
  type CapturedKind,
  captureDefaults,
  type DefaultsCapture,
  type DefaultsContextV1,
  type DefaultsRecord,
  type DefaultsReviewCase,
  type DefaultTemplate,
  defaultsReviewCase,
  type HouseholdMember,
  type HouseholdRole,
  householdsNamedBy,
  isUuid,
  MAX_EXCLUSIONS,
  MAX_GRANTS,
  type Policy,
  type PrincipalGrant,
  parseDefaultsContext,
  parseHousehold,
  parsePolicy,
  parseSharingSnapshot,
  parseTemplate,
  type ResolvedDefaults,
  reviewKinds,
  type SharingSnapshot,
  type SnapshotHousehold,
  TEMPLATE_KINDS,
  type TemplateKind,
  type UnavailableHousehold,
} from "./model/sharing-snapshot";
export type {
  CacheState,
  GateState,
  Notice,
  StatusInputs,
} from "./model/status";
export type {
  CacheRow,
  DraftRow,
  DraftStatus,
  LocalId,
  ProjectionPatch,
  ResourceId,
  ResourceKind,
} from "./model/types";
export type {
  ConfirmReviewOutcome,
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
  useQueueSummary,
  useResourceList,
  useSharingDefaults,
  useStatusInputs,
  useSyncStatusModel,
} from "./ui/react";
