/**
 * WEB-12a's PUBLIC INTERFACE for WEB-10, WEB-11 and WEB-12b (docs/sharing.md). Import the sharing editors from here, never from a deeper
 * path. The capture a queued create attaches is the data layer's (`captureDefaults(useSharingDefaults().record, kinds)` from
 * `src/data`), because it belongs with the outbox it feeds.
 *
 * Also public: `AudienceChooser` (WEB-10a R22), imported from `./AudienceChooser` itself. The editors below are part of the shell's first
 * load, and a re-export here puts the chooser there too (measured on the fixture's initial JavaScript); its only user is a lazy screen.
 */
export type { SharingApi, SharingResult } from "./api";
export {
  classifyAnswer,
  classifyThrown,
  type SharingFailure,
  untilSent,
} from "./api";
/**
 * WEB-11a's narrow extensions (docs/sharing.md, "Extensions for WEB-11a"): the online-only call rules the people screens share with the
 * sharing editors (answer classification, the bounded `not_sent` retry, one attempt per body), so a second copy of them is never written.
 * The quick policy change (D-11a-8) is the slice's OTHER public module, `./apply-policy-change`, imported from there: only the lazy people
 * screens use it, and a re-export here would put it in the entry chunk (WEB-11a review 3: the merged fixture shell's initial budget).
 */
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
  PolicyEditorRecoveryHost,
  ResourcePolicyEditor,
  type ResourcePolicyEditorProps,
} from "./ResourcePolicyEditor";
export { sharingItemPath } from "./route";
