/**
 * The public interface of the session module (plan section 6.4). Every other slice imports from here and from nowhere
 * deeper (the boundary test enforces it). Nothing here exposes the kernel, the records, or the gate.
 */
export { createBroadcastHints } from "./adapters/broadcast-hints";
export {
  type BrowserPortsOptions,
  browserPorts,
} from "./adapters/browser-ports";
export { runAuthCanary } from "./adapters/canary";
export {
  AuthStoreOpenError,
  type OpenedAuthStore,
  openAuthStore,
} from "./adapters/idb-auth-store";
export {
  createProtectedSurface,
  DIFFERENT_ACCOUNT_MESSAGE,
  type ProtectedSurfaceDeps,
} from "./adapters/protected-surface";
export { createWebLocksPort } from "./adapters/web-locks";
export type {
  AccountSummary,
  ApiCompatibility,
  AttemptHandle,
  AttemptOutcome,
  Attempts,
  BeginResult,
  CapabilityIssue,
  ConsentTicket,
  DeviceRow,
  DevicesRead,
  ExchangeResult,
  Identity,
  InvitationPreview,
  LocalWorkSummary,
  NeutralActions,
  NeutralStateId,
  OidcStartOutcome,
  OperationStart,
  Operations,
  Persistence,
  PersistenceHold,
  Recovery,
  RecoveryBegin,
  RecoveryHandle,
  RegistrationInput,
  RequestAdmission,
  RequestClass,
  Result,
  Session,
  SessionNotice,
  SessionSummary,
  SessionsRead,
  SessionView,
  StampedApi,
  StampedFailure,
  StampedFetch,
  Store,
  Wipe,
  WipeOutcome,
} from "./api";
export { StampedRequestError } from "./api";
/**
 * `openHold` is the lifecycle of a granted persistence hold (revocation at the bound, the work registered with it, the stall report), and
 * `unrevokedHold` a hold that is never revoked: both are for composing DOUBLES and the fixture's real-lock scenarios, never for the
 * session's own consumers, which ask `session.persistence.hold`.
 */
export { openHold, unrevokedHold } from "./kernel/persistence";
export {
  formatRange,
  rangeFromPin,
  type VersionRange,
} from "./model/api-version";
export type { Hint, HintChannel } from "./ports/hints";
export type { LockHandle, LockPort } from "./ports/locks";
export type { Trace } from "./ports/trace";
export { type CreateSessionOptions, createSession } from "./session";
export {
  SessionProvider,
  useApiCompatibility,
  useIdentity,
  useSession,
  useSessionNotices,
  useSessionView,
} from "./ui/context";
