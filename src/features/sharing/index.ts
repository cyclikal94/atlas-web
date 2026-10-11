/**
 * WEB-12a's PUBLIC INTERFACE for WEB-10, WEB-11 and WEB-12b (docs/sharing.md). Import the sharing editors from here, never from a deeper
 * path. The capture a queued create attaches is the data layer's (`captureDefaults(useSharingDefaults().record, kinds)` from
 * `src/data`), because it belongs with the outbox it feeds.
 */
export type { SharingApi, SharingResult } from "./api";
export {
  classifyAnswer,
  classifyThrown,
  type SharingFailure,
  untilSent,
} from "./api";
/**
 * WEB-11a's narrow extensions (docs/sharing.md, "Extensions for WEB-11a"): the quick policy change (D-11a-8), and the online-only call
 * rules the people screens share with the sharing editors (answer classification, the bounded `not_sent` retry, one attempt per body),
 * so a second copy of them is never written.
 */
export {
  applyPolicyChange,
  type PolicyChangeInput,
  type PolicyChangeOutcome,
  type PolicyChangeResult,
} from "./apply-policy-change";
export { DefaultsReview } from "./DefaultsReview";
export {
  SharingBoundary,
  type SharingEnv,
  SharingEnvProvider,
  useSharingEnv,
} from "./env";
export { samePolicy, toWirePolicy } from "./model/policy-draft";
export {
  type Attempt,
  canonicalBody,
  nextAttempt,
} from "./model/submission";
export {
  ResourcePolicyEditor,
  type ResourcePolicyEditorProps,
} from "./ResourcePolicyEditor";
export { sharingItemPath } from "./route";
